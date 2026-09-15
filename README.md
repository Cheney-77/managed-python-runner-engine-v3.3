# Managed Python Runner Engine v3.3

v3.3 is a **subtractive refactor** of v3.2.

The goal is not to add another framework layer. The core path should be readable in one pass:

```text
OperatorPublisher
      |
      v
    Catalog
      |
      v
 RunnerService
      |
      v
  WorkerPool
      |
      v
SandboxBackend
      |
      v
Trusted Agent  ->  one isolated Python child per invocation
```

## What changed from v3.2

The public model was intentionally reduced:

| v3.2 | v3.3 | Why |
|---|---|---|
| `ReleaseDescriptor` | `OperatorRelease` | It is a business object, not a descriptor of one |
| `EnvironmentDescriptor` | `RuntimeEnv` | Shorter and directly describes what it is |
| `ArtifactStore` + `EnvironmentRegistry` | `Catalog` | One place answers "what release is this and where is its artifact?" |
| `PublisherPipeline` + public Compiler/Builder chain | `OperatorPublisher` | Compilation/packing are implementation details |
| `SandboxProvider` | `SandboxBackend` | It is an execution backend, not a DI/provider abstraction |
| `AdmissionController` | `Quota` | Its responsibility is resource quota, not admission-framework plumbing |
| `ExecutionEngine` in Worker Agent | **removed** | Untrusted code must not run in the trusted agent interpreter |
| many public digests | one `release.id` + one `runtime.id` | Content identity stays; implementation hashes stop dominating the domain model |

The remaining classes exist because they correspond to real boundaries:

- **OperatorPublisher**: turns a source folder into an immutable operator release.
- **Catalog**: stores/loads immutable release metadata and artifacts.
- **RunnerService**: owns execution semantics, leases, idempotency and authorization-independent validation.
- **WorkerPool**: reuses sandboxes safely by tenant/release/runtime/profile.
- **SandboxBackend**: the narrow contract to OpenSandbox (or a test/local backend).
- **RunnerDB**: durable leases and invocation replay/audit.
- **Quota**: separate limits for sandbox creation and live sandboxes.

## Security model

### 1. The trusted agent no longer imports user modules

v3.2 loaded the user's module with `importlib` in the same process as the HTTP worker.

v3.3 does this instead:

```text
gVisor/Kata sandbox
+---------------------------------------------------+
| trusted agent                                    |
|   |                                               |
|   +-- spawn a fresh Python process per invocation |
|          |                                        |
|          +-- import and run user operator         |
|                                                   |
+---------------------------------------------------+
```

The child runs with:

- isolated Python mode (`python -I`);
- a sanitized environment;
- a new process group/session;
- `no_new_privs` on Linux when available;
- a non-root UID/GID when the trusted agent is root;
- process/file descriptor limits;
- bounded stdin/stdout/stderr;
- a hard wall-clock timeout.

An operator calling `os._exit()` now kills its own child, not the trusted agent.

The outer OpenSandbox runtime (normally gVisor or Kata) is still the real host security boundary.

### 2. Agent API has a per-worker secret

The runner creates a random bearer token for each worker. `/health`, `/bootstrap` and `/run` reject unauthenticated requests **before reading a request body**. The child does not receive that token.

### 3. Security profiles are real policy

A profile controls:

- OpenSandbox cluster (`gvisor`, `kata`, ...);
- CPU and memory;
- maximum timeout;
- network egress allow-list;
- maximum invocations before a sandbox is retired.

The runner does **not** accept a profile supplied by a NiFi invocation. The profile belongs to the trusted published `OperatorRelease`.

OpenSandbox secure runtimes are normally configured at the OpenSandbox server/runtime level, so v3.3 maps a profile to an OpenSandbox cluster. Example:

```json
{
  "standard": {
    "sandbox_cluster": "gvisor",
    "cpu": "1",
    "memory": "512Mi",
    "max_timeout_ms": 60000,
    "network_allow": [],
    "max_invocations_per_worker": 50
  },
  "hardened": {
    "sandbox_cluster": "kata",
    "cpu": "2",
    "memory": "1Gi",
    "max_timeout_ms": 30000,
    "network_allow": [],
    "max_invocations_per_worker": 1
  }
}
```

### 4. Quota now limits live sandboxes

v3.2's semaphore only limited *simultaneous creation*. v3.3 keeps two counters:

- `max_creating`: simultaneous sandbox creation;
- `max_live`: currently alive sandboxes, with an optional per-tenant cap.

The live token is released only when a sandbox is destroyed.

### 5. Lease and cancel ownership

Leases are persisted in SQLite for a single-node deployment and can be renewed. Active invocations remember:

```text
tenant + lease + release + worker
```

Cancellation must match the same tenant and lease; an arbitrary invocation UUID is not sufficient.

### 6. Idempotency

Every invocation has an `idempotency_key`. A completed result can be replayed without executing the operator again.

This improves NiFi retry behavior, but it does **not** create magical exactly-once side effects: a process crash after an external side effect but before the runner commits the result can still repeat the side effect. Operators that write external systems should use an idempotent downstream key as well.

## Operator ABI

v3.3 intentionally standardizes the operator function instead of compiling arbitrary binding graphs.

`operator.yaml`:

```yaml
name: upper
entrypoint: main:process
input_attributes:
  - filename
output_attributes:
  - mime.type
```

`main.py`:

```python
def process(content: bytes, attributes: dict[str, str], parameters: dict[str, str]):
    return {
        "content": content.upper(),
        "attributes": {"mime.type": "text/plain"},
        "relationship": "success",
    }
```

A function can also return only `bytes` or `str`.

The runner filters input and output attributes again on the server. NiFi-side filtering is defense in depth.

## Publishing

The platform/build plane should build dependency images separately, scan them, inject the **trusted v3.3 agent code as the final image layer**, and return an immutable OCI image digest such as:

```text
registry.example.com/python-operators/base@sha256:...
```

Publishing packages code; it does **not** run `pip`, `uv`, `apt`, or Docker against user-controlled dependency input in the runner process.

```python
from runner_engine.catalog import Catalog
from runner_engine.publisher import OperatorPublisher

catalog = Catalog("./catalog")
publisher = OperatorPublisher(catalog)

release = publisher.publish(
    "./examples/hello",
    runtime_image="registry.example.com/python/base@sha256:" + "a" * 64,
    profile="standard",
)
print(release.id)
```

Mutable image tags are rejected by default. Development mode can opt in explicitly.

## Running

For tests and local development there is a `LocalBackend`. It embeds the trusted `AgentState` in-process only to avoid inventing a fake local network boundary; user functions still run in one-shot child processes. **It is not a security sandbox.** Production should use `OpenSandboxBackend`.

The OpenSandbox backend accepts multiple clusters:

```python
clusters = {
    "gvisor": {"url": "http://opensandbox-gvisor:8080", "api_key": "..."},
    "kata":   {"url": "http://opensandbox-kata:8080",   "api_key": "..."},
}
```

The profile chooses the cluster.

## Restart semantics

v3.3 deliberately chooses a simple rule:

> warm workers are ephemeral; leases and completed invocation results are durable.

On runner startup, `cleanup_managed()` removes sandboxes owned by this runner version, then the pool lazily recreates workers. This is intentionally simpler and safer than pretending an in-memory pool can be reliably reconstructed from stale database rows.

For horizontally scaled production, use a shared lease/idempotency store and a distributed quota implementation. The SQLite implementation is intentionally a single-node reference implementation.

## Large FlowFiles

The reference NiFi adapter still uses inline content and intentionally has a hard limit. A production data platform should add a second content path (object-store/content-reference or streaming) rather than raising the inline limit indefinitely.

## Tests

```bash
python -m pytest
```

The tests include adversarial cases that v3.2 did not cover: process exit, global-state isolation, timeout killing, cross-lease cancellation and real live-worker quota.


## Runtime image construction rule

Do not let a user-controlled dependency installation run *after* the trusted runner agent is
placed in the image. A malicious package installer could otherwise replace the trusted package.

The safe image pipeline is conceptually:

```text
untrusted dependency build stage
        |
        v
dependency filesystem
        |
        +-- final stage: copy trusted runner_engine code LAST
        |
        v
signed/scanned immutable runtime image@sha256:...
```

At runtime the trusted agent is root only inside the outer gVisor/Kata sandbox. The user child is
UID/GID 10001 and release files remain root-owned/read-only.
