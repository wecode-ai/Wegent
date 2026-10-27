# Wegent contributor guide

Wegent is an AI-native operating system for defining, organizing, and running agent teams. Keep the system simpler after every change: reuse existing abstractions, remove obsolete paths, and fix the primary flow rather than hiding defects behind fallbacks.

## Repository map

<!-- prettier-ignore -->
| Area | Technology | Responsibility |
| --- | --- | --- |
| `backend/` | FastAPI, SQLAlchemy, MySQL | Remaining Python-owned APIs and business logic |
| `backend-rs/` | Rust, Tokio, Breeze | Primary Backend API implementation and hybrid gateway |
| `frontend/` | Next.js, React, TypeScript | Main web product |
| `wework/` | Electron, Vite, React, TypeScript | Desktop workbench and local coding experience |
| `executor/`, `executor_manager/` | Python, Docker | Agent execution and orchestration |
| `chat_shell/` | FastAPI, LangGraph | Lightweight chat runtime |
| `knowledge_runtime/`, `knowledge_doc_converter/` | FastAPI, Celery | RAG and document conversion |
| `shared/` | Python | Shared utilities, models, cryptography and telemetry |

Use `docs/en/` and `docs/zh/` for detailed architecture and guides. Keep this file limited to durable contributor rules. New documentation needs frontmatter with `sidebar_position`; write Chinese first, then English.

## Scoped instructions

- Before modifying `wework/**`, read and follow [`wework/AGENTS.md`](wework/AGENTS.md). It contains the desktop UI, local runtime, i18n, and Electron verification rules.
- Before modifying `frontend/**`, read and follow [`frontend/AGENTS.md`](frontend/AGENTS.md). It contains web-frontend state, responsive UI, and i18n rules.
- Before modifying `backend-rs/**`, read and follow [`backend-rs/AGENTS.md`](backend-rs/AGENTS.md). It defines API ownership during the Rust migration and Rust-specific verification.
- Add module-specific instructions beside a module only when they cannot be expressed as a repository-wide rule.

## Backend migration ownership

`backend-rs/` is the default implementation for new Backend APIs. Add new API
handlers in Rust, register them with `Application`, and select them in the active
route table; do not add a duplicate Python implementation as a fallback.

Existing APIs that have not migrated remain owned by `backend/`. Do not infer
ownership from a shared utility, a Rust foundation module, or the existence of
a similarly named Python route. An existing API is Rust-owned only when both of
these are true:

1. `backend-rs` registers a Rust handler for it.
2. An active `WEGENT_RS_ROUTES_FILE` rule selects its method and path for Rust
   (the repository default is `backend-rs/config/routes.toml`).

The checked-in default route table is the inventory of active Rust-owned APIs,
including migrated and newly added routes; every other request is forwarded to
Python. Use the following ownership rules for every API change:

| Change | Where to implement it |
| --- | --- |
| New Backend API | `backend-rs/`; add the handler, active route entry, and focused tests together. |
| Existing API not selected for Rust | `backend/` |
| Existing API already selected for and implemented by Rust | `backend-rs/` |

### Finding Rust-owned APIs

`backend-rs/config/routes.toml` is the checked-in inventory of public APIs
selected for Rust. Before changing an existing API, inspect each `[[routes]]`
entry for the matching method and path, then confirm its Rust handler is
registered by `Application`. If the task specifies `WEGENT_RS_ROUTES_FILE`, use
that file instead. Do not maintain a separate hand-written API inventory: the
route configuration must remain the single source of truth. Creating or
migrating a Rust API must update the handler, its route entry, and focused
compatibility tests together.

Do not duplicate a behavior change in both implementations merely because the
hybrid gateway has a Python fallback. For a new API, its Rust handler, route
entry, and focused tests are part of the feature change. Moving an existing
Python-owned API to Rust or adding/upgrading Rust dependencies remains migration
work and needs explicit task scope. If the handler registration and route
selection do not agree, stop and ask for direction rather than choosing an owner
by guesswork.

## Domain model

```
Ghost (prompt, MCP servers, skills)
  -> Bot (Ghost + Shell + optional Model)
  -> Team (Bots + collaboration mode)
  -> Task (Team + Workspace)
```

Code uses CRD terms. In Chinese UI, `Team` is “智能体” and `Bot` is “机器人”; English UI calls them Agent and Bot.

- A Kind resource is identified by `namespace`, `name`, and `user_id`; always query all three.
- `Task` and `Workspace` use `TaskResource` in `tasks`; other CRDs use `Kind` in `kinds`.
- Shell types: `Codex`, `ClaudeCode`, `Agno`, `Dify`, and `Chat`.

## Engineering rules

- Collaboration permission changes must follow [the permission contract](docs/en/wegent/developer-guide/collaboration-permissions.md) and preserve its CP invariants. Update the architecture transaction and contract tests together; changing an invariant requires explicit user authorization. Never weaken, skip, or delete security assertions to make an incompatible implementation pass.

- Diagnose problems from logs, actual code, and other concrete evidence first. When evidence is insufficient, add focused diagnostic logging before changing behavior; do not guess.
- Comments are English. Use clear names, type hints for Python, and keep functions focused (prefer under 50 lines).
- Before adding code, search for and reuse existing components, services, utilities, and patterns. Extract shared logic instead of duplicating it.
- Favor cohesive modules, explicit interfaces, and standard practices. Split files over 1000 lines.
- Delete dead code. Do not add compatibility shims or fallback paths without agreement; correct the primary path.
- Fix defects discovered while working when they are in scope or block correctness.

### Python

- Use `uv run` for every Python command.
- Follow PEP 8, Black (88 columns), isort, and type hints.
- Mock external services in unit tests; use Arrange, Act, Assert.

### TypeScript and React

- Use strict TypeScript, function components, `const`, single quotes, and no semicolons.
- Check existing UI in `src/components/ui/`, `src/components/common/`, and feature components before creating new components.
- Preserve existing `data-testid` values; if one changes, update its E2E coverage in the same change. All new interactive elements need descriptive `data-testid` values.
- Run a package-owned binary through that package, for example `pnpm --filter wework exec prettier`; do not use root-level `pnpm exec` for tools declared only in a workspace package.

## Testing and verification

Prioritize fast, iterative development. Run E2E tests and `ai:verify` only when the user explicitly requests them, except for changes to desktop updating, rollback, upgrade data migration, or their packaging and release gates: those changes require focused real packaged-Electron upgrade and rollback E2E verification. This execution policy overrides other automatic E2E and real-Electron verification requirements in scoped guides; those guides still define how to verify when requested.

Desktop update eligibility must come from exact, CI-verified source-to-target package pairs. A target's minimum source version is a constraint, never proof of compatibility. Preserve required intermediate packages, and never promote an upgrade edge without successful upgrade and rollback evidence bound to the delivered package hashes. See `wework/AGENTS.md` for the maintenance contract.

Run focused tests before committing; run broader tests when risk warrants it. E2E tests may mock only model services; every other component and integration must be real. They may not silently skip or fail gracefully, and failures must be fixed rather than skipped.
Treat intermittent test failures as defects: investigate and fix them immediately before proceeding; never use reruns or retries to obtain a passing result or hide the underlying problem.
Every E2E scenario must be invoked by GitHub CI. Focused local E2E commands may exist for debugging, but they must also be included by a CI-covered suite; do not add dead E2E coverage that CI never runs.
Long desktop E2E flows must expose registered checkpoints through the shared runner. A checkpoint must establish its own minimal prerequisites so both one-checkpoint and from-checkpoint runs are valid; do not depend on state created only by an earlier skipped checkpoint.

```bash
cd backend && uv run pytest
cd executor && uv run pytest
pnpm --dir frontend test
```

## Git workflow

- Branches: `<type>/<description>` where type is `feature`, `fix`, `refactor`, `docs`, `test`, or `chore`.
- Commits use Conventional Commits: `<type>[scope]: <description>`.
- Respect Husky output; never use `--no-verify`.
- Pull the latest main branch and resolve conflicts before opening a PR. Run `git push` in an isolated background process because pre-push checks are expensive.

## Module quick reference

- Python-owned Backend endpoints: API route in `backend/app/api/`, schemas in `backend/app/schemas/`, logic in `backend/app/services/`. Persistent model changes require an Alembic migration; verify `upgrade head` and the rollback before handing off.
- Rust Backend: read `backend-rs/AGENTS.md` before changing it. Implement new Backend APIs here and add active route entries for them; routes that remain Python-owned continue to proxy to `backend/`.
- Executor types live in `executors/`; scheduler/orchestration lives in `executor_manager/`.
- Knowledge Runtime serves internal RAG APIs on port 8200. The converter uses the `knowledge_conversion` Celery queue.
- Chat Shell supports `http`, `package`, and `cli` modes.
- For changed Backend or Executor critical paths, use the tracing helpers in `shared/telemetry/decorators.py` instead of creating uninstrumented asynchronous main flows.

## Security

- Architecture ledgers and evidence are local-only. Never commit `.live-architecture/` or include it in build, container, or deployment artifacts.

- Never commit credentials or session files. Use environment configuration for secrets.
- Only expose client-safe frontend settings through the appropriate public environment variable convention.
- Do not log tokens, API keys, or the contents of local authentication files.

## Common ports

`frontend` 3000, `backend` 8000, `chat_shell` 8001, `knowledge_runtime` 8200, MySQL 3306, Redis 6379.
