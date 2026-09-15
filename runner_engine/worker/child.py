from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import traceback
from pathlib import Path


def _encode_content(value) -> bytes:
    if value is None:
        return b""
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8")
    raise TypeError("operator result content must be bytes, bytearray, str, or None")


def _normalize_result(value, original_content: bytes) -> dict:
    if value is None:
        return {
            "status": "SUCCEEDED",
            "content": original_content,
            "attributes": {},
            "relationship": "success",
            "retryable": False,
            "error_code": "",
            "error_message": "",
        }

    if isinstance(value, (bytes, bytearray, str)):
        return {
            "status": "SUCCEEDED",
            "content": _encode_content(value),
            "attributes": {},
            "relationship": "success",
            "retryable": False,
            "error_code": "",
            "error_message": "",
        }

    if not isinstance(value, dict):
        raise TypeError("operator must return bytes, str, dict or None")

    attributes = value.get("attributes", {})
    if not isinstance(attributes, dict) or not all(
        isinstance(key, str) and isinstance(item, str) for key, item in attributes.items()
    ):
        raise TypeError("result attributes must be dict[str, str]")

    retryable = value.get("retryable", False)
    if not isinstance(retryable, bool):
        raise TypeError("retryable must be a boolean")

    status = value.get("status")
    if status is None:
        status = "FAILED" if retryable else "SUCCEEDED"
    if status not in {"SUCCEEDED", "FAILED"}:
        raise ValueError("status must be SUCCEEDED or FAILED")
    if status == "SUCCEEDED" and retryable:
        raise ValueError("a successful result cannot be retryable")

    default_relationship = "retry" if retryable else ("failure" if status == "FAILED" else "success")
    relationship = value.get("relationship", default_relationship)
    if not isinstance(relationship, str) or not relationship:
        raise TypeError("relationship must be a non-empty string")

    error_code = value.get("error_code", "")
    error_message = value.get("error_message", "")
    if not isinstance(error_code, str) or not isinstance(error_message, str):
        raise TypeError("error_code and error_message must be strings")

    if status == "FAILED" and not error_code:
        error_code = "OPERATOR_REPORTED_FAILURE"

    return {
        "status": status,
        "content": _encode_content(value.get("content", original_content)),
        "attributes": attributes,
        "relationship": relationship,
        "retryable": retryable,
        "error_code": error_code,
        "error_message": error_message,
    }


def _validate_output(content: bytes, attributes: dict[str, str]) -> None:
    max_output = int(os.environ.get("RUNNER_MAX_OUTPUT_BYTES", str(8 * 1024 * 1024)))
    max_attributes = int(os.environ.get("RUNNER_MAX_ATTRIBUTES", "128"))
    max_attribute_bytes = int(os.environ.get("RUNNER_MAX_ATTRIBUTE_BYTES", "65536"))

    if len(content) > max_output:
        raise ValueError("operator output exceeds byte limit")
    if len(attributes) > max_attributes:
        raise ValueError("operator output has too many attributes")

    attribute_bytes = sum(
        len(key.encode("utf-8")) + len(value.encode("utf-8"))
        for key, value in attributes.items()
    )
    if attribute_bytes > max_attribute_bytes:
        raise ValueError("operator output attributes exceed byte limit")


def execute(request: dict) -> dict:
    release_root = Path(request["release_root"]).resolve()
    dependency_root = request.get("dependency_root")
    entrypoint = request["entrypoint"]

    module_name, function_name = entrypoint.split(":", 1)
    content = base64.b64decode(request.get("content_b64", ""), validate=True)
    attributes = dict(request.get("attributes", {}))
    parameters = dict(request.get("parameters", {}))

    original_sys_path = list(sys.path)
    import_paths = [str(release_root)]

    if dependency_root:
        dependency_path = Path(dependency_root).resolve()
        if dependency_path.is_dir():
            import_paths.append(str(dependency_path))

    sys.path[:] = import_paths + original_sys_path

    try:
        module = importlib.import_module(module_name)
        target = getattr(module, function_name)
        value = target(content=content, attributes=attributes, parameters=parameters)

        normalized = _normalize_result(value, content)
        _validate_output(normalized["content"], normalized["attributes"])

        return {
            "status": normalized["status"],
            "relationship": normalized["relationship"],
            "content_b64": base64.b64encode(normalized["content"]).decode("ascii"),
            "attributes": normalized["attributes"],
            "retryable": normalized["retryable"],
            "error_code": normalized["error_code"],
            "error_message": normalized["error_message"],
        }
    finally:
        sys.path[:] = original_sys_path


def main() -> None:
    try:
        raw = sys.stdin.buffer.read()
        if len(raw) > 12 * 1024 * 1024:
            raise ValueError("child request too large")

        request = json.loads(raw)
        response = execute(request)
        sys.stdout.write(json.dumps(response, sort_keys=True, separators=(",", ":")))

    except BaseException as exc:
        response = {
            "status": "FAILED",
            "relationship": "failure",
            "content_b64": "",
            "attributes": {},
            "retryable": False,
            "error_code": "USER_EXCEPTION",
            "error_message": "".join(
                traceback.format_exception(type(exc), exc, exc.__traceback__)
            )[-8192:],
        }

        try:
            sys.stdout.write(json.dumps(response, sort_keys=True, separators=(",", ":")))
        except Exception:
            pass


if __name__ == "__main__":
    main()
