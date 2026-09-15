from __future__ import annotations

import argparse
import base64
import ctypes
import hmac
import json
import os
import resource
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from .materialize import ReleaseMaterializer

MAX_BODY = 16 * 1024 * 1024
MAX_STDERR = 1024 * 1024
DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024


def _linux_prctl(option: int, arg2: int) -> None:
    if not sys.platform.startswith("linux"):
        return
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(option, arg2, 0, 0, 0)
    except Exception:
        pass


def _mark_agent_nondumpable() -> None:
    # PR_SET_DUMPABLE = 4
    _linux_prctl(4, 0)


def _child_setup(uid: int, gid: int, max_processes: int) -> None:
    # PR_SET_NO_NEW_PRIVS = 38
    _linux_prctl(38, 1)
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    except Exception:
        pass

    if max_processes > 0:
        try:
            resource.setrlimit(resource.RLIMIT_NPROC, (max_processes, max_processes))
        except Exception:
            pass

    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)


def _kill_user_processes(uid: int) -> None:
    """Best-effort cleanup for child processes that escape the invocation process group."""
    if not sys.platform.startswith("linux") or os.geteuid() != 0 or uid == 0:
        return

    for _ in range(3):
        found = False
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue

            pid = int(entry.name)
            if pid == os.getpid():
                continue

            try:
                text = (entry / "status").read_text(encoding="utf-8", errors="ignore")
                uid_line = next((line for line in text.splitlines() if line.startswith("Uid:")), "")
                real_uid = int(uid_line.split()[1]) if uid_line else -1
                if real_uid == uid:
                    os.kill(pid, signal.SIGKILL)
                    found = True
            except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError, StopIteration):
                continue

        if not found:
            break
        time.sleep(0.02)


def _kill_group(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except Exception:
        proc.kill()


def _bounded_reader(
    stream,
    target: bytearray,
    cap: int,
    overflow: threading.Event,
    proc: subprocess.Popen,
) -> None:
    try:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return
            if len(target) + len(chunk) > cap:
                overflow.set()
                _kill_group(proc)
                return
            target.extend(chunk)
    finally:
        try:
            stream.close()
        except Exception:
            pass


class AgentState:
    """Trusted code inside the outer sandbox. It never imports an operator module."""

    def __init__(
        self,
        *,
        token: str,
        releases_root: str | Path,
        dependency_root: str | Path | None = "/opt/python-deps",
        child_uid: int = 10001,
        child_gid: int = 10001,
        child_nproc: int = 64,
    ):
        self.token = token
        self.materializer = ReleaseMaterializer(releases_root)
        self.dependency_root = Path(dependency_root).resolve() if dependency_root else None
        self.child_uid = child_uid
        self.child_gid = child_gid
        self.child_nproc = child_nproc
        self._releases: dict[str, tuple[Path, dict]] = {}
        self._lock = threading.RLock()

    def bootstrap(self, payload: dict) -> dict:
        release_id = payload["release_id"]
        artifact = base64.b64decode(payload["artifact_b64"], validate=True)
        path = self.materializer.install(release_id, payload["artifact_sha256"], artifact)
        manifest = json.loads((path / "operator.json").read_text(encoding="utf-8"))
        if manifest.get("id") != release_id:
            raise ValueError("release id in operator.json does not match bootstrap request")

        with self._lock:
            self._releases[release_id] = (path, manifest)

        return {"ok": True}

    def run(self, payload: dict) -> dict:
        release_id = payload["release_id"]
        with self._lock:
            pair = self._releases.get(release_id)
        if pair is None:
            raise ValueError("release is not bootstrapped")

        release_root, manifest = pair
        request = {
            "release_root": str(release_root),
            "dependency_root": str(self.dependency_root) if self.dependency_root else None,
            "entrypoint": manifest["entrypoint"],
            "content_b64": payload.get("content_b64", ""),
            "attributes": payload.get("attributes", {}),
            "parameters": payload.get("parameters", {}),
        }
        raw = json.dumps(request, sort_keys=True, separators=(",", ":")).encode("utf-8")
        timeout_ms = max(1, int(payload.get("timeout_ms", 30_000)))
        max_output = max(1, int(payload.get("max_output_bytes", DEFAULT_MAX_OUTPUT)))

        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PYTHONUNBUFFERED": "1",
            "RUNNER_MAX_OUTPUT_BYTES": str(max_output),
            "RUNNER_MAX_ATTRIBUTES": str(int(payload.get("max_attributes", 128))),
            "RUNNER_MAX_ATTRIBUTE_BYTES": str(int(payload.get("max_attribute_bytes", 65_536))),
        }

        started = time.monotonic()
        child_script = str(Path(__file__).with_name("child.py"))
        preexec_fn = None
        if os.name == "posix":
            preexec_fn = lambda: _child_setup(self.child_uid, self.child_gid, self.child_nproc)

        proc = subprocess.Popen(
            [sys.executable, "-I", child_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            start_new_session=True,
            preexec_fn=preexec_fn,
        )
        assert proc.stdin and proc.stdout and proc.stderr

        stdout = bytearray()
        stderr = bytearray()
        overflow = threading.Event()
        out_thread = threading.Thread(
            target=_bounded_reader,
            args=(proc.stdout, stdout, max_output * 2 + 1024 * 1024, overflow, proc),
            daemon=True,
        )
        err_thread = threading.Thread(
            target=_bounded_reader,
            args=(proc.stderr, stderr, MAX_STDERR, overflow, proc),
            daemon=True,
        )
        out_thread.start()
        err_thread.start()

        try:
            proc.stdin.write(raw)
            proc.stdin.close()
            try:
                proc.wait(timeout=timeout_ms / 1000.0)
            except subprocess.TimeoutExpired:
                _kill_group(proc)
                proc.wait(timeout=2)
                _kill_user_processes(self.child_uid)
                return {
                    "status": "FAILED",
                    "relationship": "failure",
                    "content_b64": "",
                    "attributes": {},
                    "retryable": False,
                    "error_code": "TIMEOUT",
                    "error_message": f"operator exceeded {timeout_ms} ms",
                    "duration_ms": int((time.monotonic() - started) * 1000),
                }
        finally:
            if proc.poll() is None:
                _kill_group(proc)
            out_thread.join(timeout=2)
            err_thread.join(timeout=2)
            _kill_user_processes(self.child_uid)

        duration = int((time.monotonic() - started) * 1000)
        if overflow.is_set():
            return {
                "status": "FAILED",
                "relationship": "failure",
                "content_b64": "",
                "attributes": {},
                "retryable": False,
                "error_code": "OUTPUT_LIMIT",
                "error_message": "operator stdout/stderr exceeded configured limit",
                "duration_ms": duration,
            }

        if proc.returncode != 0 and not stdout:
            return {
                "status": "FAILED",
                "relationship": "failure",
                "content_b64": "",
                "attributes": {},
                "retryable": False,
                "error_code": "USER_PROCESS_EXITED",
                "error_message": bytes(stderr[-4096:]).decode("utf-8", "replace"),
                "duration_ms": duration,
            }

        try:
            response = json.loads(stdout)
        except Exception:
            return {
                "status": "FAILED",
                "relationship": "failure",
                "content_b64": "",
                "attributes": {},
                "retryable": False,
                "error_code": "INVALID_CHILD_RESPONSE",
                "error_message": bytes(stderr[-4096:]).decode("utf-8", "replace"),
                "duration_ms": duration,
            }

        response["duration_ms"] = duration
        return response


def _handler_for(state: AgentState):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ManagedPythonAgent/3.3"

        def log_message(self, format, *args):
            return

        def _authorized(self) -> bool:
            return hmac.compare_digest(self.headers.get("X-Runner-Agent-Token", ""), state.token)

        def _json(self, status: int, value: dict) -> None:
            body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _payload(self) -> dict:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise ValueError("invalid Content-Length") from exc
            if length < 0 or length > MAX_BODY:
                raise ValueError("request body too large")

            value = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(value, dict):
                raise ValueError("request body must be a JSON object")
            return value

        def do_GET(self):
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            if self.path != "/health":
                self._json(404, {"error": "not found"})
                return
            self._json(200, {"ok": True})

        def do_POST(self):
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return

            try:
                payload = self._payload()
                if self.path == "/bootstrap":
                    self._json(200, state.bootstrap(payload))
                elif self.path == "/run":
                    self._json(200, state.run(payload))
                else:
                    self._json(404, {"error": "not found"})
            except Exception as exc:
                self._json(400, {"error": type(exc).__name__, "message": str(exc)})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default=os.environ.get("RUNNER_AGENT_LISTEN", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("RUNNER_AGENT_PORT", "9080")))
    parser.add_argument("--releases", default=os.environ.get("RUNNER_RELEASES_ROOT", "/opt/runner/releases"))
    args = parser.parse_args()

    token = os.environ.get("RUNNER_AGENT_TOKEN")
    if not token:
        raise SystemExit("RUNNER_AGENT_TOKEN is required")

    _mark_agent_nondumpable()
    state = AgentState(
        token=token,
        releases_root=args.releases,
        dependency_root=os.environ.get("RUNNER_DEPENDENCY_ROOT", "/opt/python-deps"),
        child_uid=int(os.environ.get("RUNNER_CHILD_UID", "10001")),
        child_gid=int(os.environ.get("RUNNER_CHILD_GID", "10001")),
        child_nproc=int(os.environ.get("RUNNER_CHILD_NPROC", "64")),
    )
    print(f"[managed-python-agent] listening on {args.listen}:{args.port}", flush=True)
    HTTPServer((args.listen, args.port), _handler_for(state)).serve_forever()


if __name__ == "__main__":
    main()
