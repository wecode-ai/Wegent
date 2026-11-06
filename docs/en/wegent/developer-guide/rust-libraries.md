---
sidebar_position: 45
---

# Rust libraries and build boundaries

Backend and Executor compile, test, and release independently, each with its own Cargo lockfile. They reuse source libraries through local path dependencies, without depending on the other application's binary or creating a repository-wide Cargo workspace.

## Library responsibilities

| Location | Crate | Responsibility |
| --- | --- | --- |
| `shared/rust/protocol` | `wegent-protocol` | Backend dispatch assembly, Executor request decoding, task status, and protocol values |
| `shared/rust/crypto` | `wegent-crypto` | Explicit-key/IV AES-CBC primitives and strict PKCS#7 |
| `backend-rs/crates/python-compat` | `wegent-python-compat` | Python JSON serialization, value conversion, and integer-set iteration compatibility |
| `backend-rs/crates/http-compat` | `wegent-http-compat` | FastAPI-compatible errors for Breeze HTTP services |
| `backend-rs/crates/storage` | `wegent-storage` | S3 header/query signing and object-path encoding |

Shared libraries do not read application environment variables, access databases, or decide permissions. Applications resolve configuration and keys, send requests, and map algorithm errors to their existing business responses. The S3 timestamp helper only reads the clock.

`dispatch::ExecutionRequest` is the producer projection after Backend resolves resources; the root `ExecutionRequest` is the tolerant Executor consumer projection. Their fields and defaults differ and must not be mechanically unified. Contract tests verify that producer-assembled JSON decodes into the consumer projection. The consumer's `agent_home_runtime_task_id` is trusted local metadata and is not deserialized from requests.

`wegent-crypto::decrypt_cbc` strictly validates PKCS#7. Only the historical MCP provider path uses `decrypt_cbc_blocks` followed by its original padding removal; that primitive neither validates nor removes padding, and regression coverage pins the difference. Executor Git tokens and subscription encryption retain their original AES-256 restrictions. Applications retain their empty-value, configuration-error, and decryption-failure policies.

## Development and verification

Run from the repository root:

```bash
# Backend application and private libraries; backend-rs/Cargo.lock
cargo check --manifest-path backend-rs/Cargo.toml --locked --tests --examples
cargo test --manifest-path backend-rs/Cargo.toml --locked

# Executor; executor/Cargo.lock
cargo check --manifest-path executor/Cargo.toml --locked --all-targets --all-features
cargo test --manifest-path executor/Cargo.toml --locked --all-features

# Shared libraries and producer-to-consumer contracts; shared/rust/Cargo.lock
cargo test --manifest-path shared/rust/Cargo.toml --locked
```

The Backend workspace includes the application and its private libraries as default members. The shared workspace has a separate lockfile for library tests; applications still resolve dependencies through their own lockfiles. Application `cargo test` does not run external dependency unit tests, so the existing Backend CI test job explicitly checks shared-library formatting, tests, and Clippy.

Shared-source changes must select Backend, Executor, and their existing integration checks. Docker dependency and application stages both need shared sources. Dependency-image, runtime-image, and macOS/Windows build fingerprints include shared and application-private libraries. Update these inputs when adding local crates so cached binaries cannot omit source changes.
