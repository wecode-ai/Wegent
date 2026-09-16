# Wegent Internal Rust Backend Migration Guide

## Purpose and Repository Layout

This directory contains the internal Rust edition of the Wegent backend. It
owns functionality tied to Weibo's internal environment, products, and business
rules while reusing the adjacent open-source Rust backend.

| Path | Role | Allowed content |
| --- | --- | --- |
| `.` (`backend-rs-intra`) | Internal Rust backend | Weibo-, Wecode-, and Sina-specific functionality and anything that cannot be open-sourced |
| `../backend-rs` | Open-source Rust backend | General-purpose functionality unrelated to Weibo, Wecode, or Sina and suitable for independent reuse |
| `../backend` | Python migration source | The current Python backend, which still mixes open-source and internal functionality |
| `../../wegent-be-rs` | Rust reference implementation | Previously completed Rust migration code used as a read-only source for selective copying |

The dependency direction is strictly:

```text
backend-rs-intra -> ../backend-rs
```

`../backend-rs` must never depend on, reference, or require
`backend-rs-intra`. Do not duplicate the same general-purpose implementation in
both Rust projects.

## Code Ownership Rules

- Source ownership is determined solely by its path under `../backend`:
  non-`wecode` source code must migrate only to `../backend-rs`; `wecode/**`
  source code must migrate only to this directory (`backend-rs-intra`).
- **Absolute boundary:** code from `../backend/wecode/**` or any of its
  subdirectories must never enter `../backend-rs`. This prohibition applies
  equally to copying, porting, refactoring, extracting a helper, or adapting
  the code under a different name. Such code must migrate only to
  `backend-rs-intra`.
- Do not reclassify code based on its apparent generality, its call graph, or
  open-source eligibility: a `wecode/**` source symbol remains internal, and a
  non-`wecode` source symbol remains public.
- Never move internal domains, credentials, keys, private protocols, internal
  data samples, or internal-only test fixtures into `../backend-rs`.

## Migration Sources

- Treat `../backend` as the authoritative source for current Python behavior,
  routing, ownership, and dependency analysis.
- Use `../../wegent-be-rs` as a reference implementation when equivalent Rust
  code already exists. Copy only the relevant implementation; never move,
  delete, or rewrite the reference repository as part of this migration.
- Reclassify copied code using this repository's ownership rules. Its original
  location in the reference repository does not override the open-source and
  internal boundaries defined above.
- Code under `../../wegent-be-rs/src/wecode/**` is internal by definition and
  may be copied only into `backend-rs-intra`; it must never be used as a source
  for `../backend-rs`, including through a refactored or extracted helper.
- Preserve behavior rather than file layout. Reuse useful modules and tests,
  but adapt their boundaries to the two-project dependency direction.

## Migration Plan

| Phase | Scope | Current status |
| --- | --- | --- |
| 1. Runtime foundation | Establish the reusable hybrid gateway, internal binary, and one-way dependency | completed |
| 2. API inventory | Trace routes and call graphs in `../backend` and classify their ownership | planned |
| 3. Open-source migration | Move APIs and shared capabilities without internal dependencies into `../backend-rs` | planned |
| 4. Internal migration | Move `../backend/wecode/**` and other internal APIs into this directory | planned |
| 5. Incremental cutover | Implement, verify, and switch each API from Python fallback to Rust | planned |

Migrate in small, independently verifiable API batches. Do not translate the
entire Python backend in one pass.

## Behavioral Fidelity

- A request to migrate an API means migrating its complete observable behavior
  by default. This includes authentication and authorization, transitive
  service and database lookups, validation, side effects, status codes,
  headers, and response bodies.
- Treat every dependency in the API's reachable call graph as part of the
  migration scope. A missing Rust dependency is work to implement or reuse, not
  a reason to weaken the source behavior.
- Do not offer reduced-fidelity alternatives such as JWT-only authentication,
  skipped user-state checks, placeholder data, or changed error handling unless
  the user explicitly requests a behavioral change.
- A route registration, empty handler, mock response, or Python-fallback result
  is scaffolding only and does not count as a migrated API.
- Ask for clarification only when the authoritative Python behavior or the
  ownership boundary is genuinely ambiguous. Do not ask whether to omit known
  source behavior for implementation convenience.

### Migrating One API

1. Locate the Python route, schema, service, repository, and startup-time
   dependencies in `../backend`, then trace the complete call graph.
2. Select the Rust destination using the ownership rules above before copying
   or implementing code.
3. If the API must be split, first establish a general interface or core in
   `../backend-rs`, then implement the internal adapter here. Preserve the
   one-way dependency.
4. Implement the handler, state, and tests in the owning Rust project. A route
   must have exactly one owner.
5. Verify both `backend-rs-intra` and `../backend-rs`, including the ability to
   build and test the open-source project independently.
6. Update the API-specific task or MR record only after Rust handles the route
   and acceptance is complete. A response served by the Python fallback is not
   a migrated API.

## API-Specific Migration Records

Do not add individual API names, live migration status, or endpoint-specific
plans to this file. Keep those details in the corresponding task or MR
description, or in a dedicated migration document when the work needs a
long-lived design record. Each record should include:

- the Python route and complete call graph;
- the copied reference files and symbols, if any;
- the destination of every Rust module and the evidence for that ownership;
- Python cleanup candidates and evidence that no other API uses them;
- tests, cutover state, and final acceptance status.

## Retiring Python Code

- Do not change the canonical Python behavior while it is still needed as the
  compatibility source or fallback for an unfinished Rust migration.
- After the Rust route has completed compatibility verification and cutover,
  identify Python symbols used exclusively by that migrated API. Prove
  exclusivity through reference searches, call-graph inspection, and relevant
  tests; do not infer it from filenames.
- For the first removal pass, comment out only the proven exclusive code and
  add a marker in the following form:

  ```python
  # MIGRATION-CANDIDATE(api="<METHOD> <PATH>"): remove after final confirmation.
  ```

- Keep the trial removal in a focused commit and run the affected Python test
  suite. Do not comment out shared models, utilities, startup hooks, or side
  effects still used by another API.
- Permanently delete the commented code only after explicit confirmation that
  the Rust cutover is complete and no remaining Python path depends on it.

## Development and Delivery Rules

- Read and follow the repository-wide `../AGENTS.md` before making changes.
- When splitting a mixed migration branch for public and internal delivery, read [`docs/migration-delivery.md`](docs/migration-delivery.md) and use its script-led workflow. Do not decide file ownership manually.
- Changes to `../backend-rs` must contain no internal knowledge and must keep it
  independently buildable as an open-source project.
- This project may use `../backend-rs` through a path dependency. Never add the
  reverse dependency.
- When one migration changes both directories, keep commits separated by
  responsibility when practical so open-source changes can be synchronized
  cleanly.
- Preserve existing Rust module boundaries, use Tokio for asynchronous code,
  forbid `unsafe`, and keep product source files below 1,000 lines.
- At minimum, run `cargo fmt --all --check`, `cargo test --workspace`, and
  `cargo clippy --workspace --all-targets -- -D warnings`. When both projects
  change, run the checks for both projects.
