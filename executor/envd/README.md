# envd Runtime Archive

The Rust executor currently uses the `envd` module for runtime workspace and
home-directory archive handling. The active implementation lives in
`executor/src/envd/archive.rs` and is covered by
`executor/tests/envd_archive_contract.rs`.

## Current Rust Surface

`create_runtime_archive` creates a gzip-compressed tar archive with two logical
roots:

- `workspace/` for the task workspace.
- `home/` for the runtime home directory when it exists.

`restore_runtime_archive` restores archives into separate workspace and home
paths. It also accepts older archives that did not include the `workspace/`
prefix so existing archived task state can still be restored.

## Archive Modes

| Mode | Behavior |
|------|----------|
| `Executor` | Preserves workspace `.git` data, `.claude_session_id`, and selected Claude home state needed for executor task resume. |
| `Sandbox` | Preserves user workspace and home files while excluding runtime directories that should not be restored into a fresh sandbox. |

Both modes reject archives larger than the configured maximum size and ignore
unsafe restore paths.

## Tests

Run the Rust contract tests from the executor directory:

```bash
cargo test --test envd_archive_contract --all-features
```

Run the full executor Rust test suite with:

```bash
cargo test --all-features
```

## Legacy Files

The `executor/envd/` directory still contains the previous Python Connect RPC
prototype files and protobuf specs. They are not used to start the Rust
`wegent-executor` binary. Treat them as protocol/reference material unless a
future change explicitly wires Connect RPC services back into the Rust runtime.
