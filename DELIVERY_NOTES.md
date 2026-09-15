# v3.3 Delivery Notes

## Validation performed in this delivery environment

- `python -m compileall -q runner_engine tests`: PASS
- Python test suite: **14 tests PASS**
- Maven POM XML parsing: PASS
- Public Python class inventory checked: no class ends in
  `Descriptor`, `Builder`, `Compiler`, `Registry`, or `Provider`
- OpenSandbox adapter contract test covers:
  - nested lifecycle status
  - CPU / memory limits
  - deny-by-default network policy
  - egress allow-list
  - secure access
  - Kubernetes-label-safe ownership metadata
- Adversarial execution tests cover:
  - `os._exit()` does not kill the trusted agent
  - Python globals do not leak between invocations
  - hard execution timeout
  - cross-lease cancellation rejection
  - live sandbox quota
  - idempotent worker destruction

## Not validated here

The following need the target deployment environment and are intentionally **not** claimed as
validated by this delivery:

1. Real OpenSandbox + gVisor/Kata end-to-end deployment.
2. Maven/NAR compilation against the exact NiFi 2.x distribution used by the platform.
3. Horizontal runner scaling. `RunnerDB` is a deliberately simple single-node SQLite reference.
4. Large FlowFile transport. v3.3 keeps an 8 MiB inline path; production should add a content
   reference / object-store or streaming path.
5. The isolated dependency build service. v3.3 defines the trust contract (immutable scanned OCI
   image, trusted agent copied in the final image layer) but does not put arbitrary user package
   installation back into the runner process.
6. Secret brokering for operators. Do not pass platform secrets as ordinary FlowFile attributes.

## Main compatibility break from v3.2

v3.3 removes the general-purpose ContractCompiler/binding-plan abstraction and standardizes the
operator ABI to:

```python
def process(content: bytes, attributes: dict[str, str], parameters: dict[str, str]):
    ...
```

This is deliberate. If the existing editor exposes a richer user-facing programming model, add a
small compatibility adapter at publish time; do not reintroduce the old compiler/builder object
graph into the runner core.

## Recommended next production milestones

- Run the OpenSandbox adapter against a real gVisor cluster first, then a Kata profile.
- Compile/install the NAR against the exact NiFi version and run retry/restart integration tests.
- Move SQLite lease/idempotency state to a shared store only when horizontal runner replicas are
  actually required.
- Add a large-content reference transport before increasing the inline byte limit.
- Build the dependency/image service as a separate security boundary with internal PyPI mirror,
  package policy, vulnerability scanning, SBOM and image signing.
