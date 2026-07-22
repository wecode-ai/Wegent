# Wegent contributor guide

Wegent is an AI-native operating system for defining, organizing, and running agent teams. Keep the system simpler after every change: reuse existing abstractions, remove obsolete paths, and fix the primary flow rather than hiding defects behind fallbacks.

## Repository map

| Area | Technology | Responsibility |
| --- | --- | --- |
| `backend/` | FastAPI, SQLAlchemy, MySQL | REST API and business logic |
| `frontend/` | Next.js, React, TypeScript | Main web product |
| `wework/` | Tauri, Vite, React, TypeScript | Desktop workbench and local coding experience |
| `executor/`, `executor_manager/` | Python, Docker | Agent execution and orchestration |
| `chat_shell/` | FastAPI, LangGraph | Lightweight chat runtime |
| `knowledge_runtime/`, `knowledge_doc_converter/` | FastAPI, Celery | RAG and document conversion |
| `shared/` | Python | Shared utilities, models, cryptography and telemetry |

Use `docs/en/` and `docs/zh/` for detailed architecture and guides. Keep this file limited to durable contributor rules. New documentation needs frontmatter with `sidebar_position`; write Chinese first, then English.

## Scoped instructions

- Before modifying `wework/**`, read and follow [`wework/AGENTS.md`](wework/AGENTS.md). It contains the desktop UI, local runtime, i18n, and Tauri verification rules.
- Before modifying `frontend/**`, read and follow [`frontend/AGENTS.md`](frontend/AGENTS.md). It contains web-frontend state, responsive UI, and i18n rules.
- Add module-specific instructions beside a module only when they cannot be expressed as a repository-wide rule.

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
- Shell types: `ClaudeCode`, `Agno`, `Dify`, and `Chat`.

## Engineering rules

- Analyze concrete problems using logs and the actual code, and complete tasks based on evidence rather than speculation.
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

## Testing and verification

Run focused tests before committing; run broader tests when risk warrants it. E2E tests must use real backend requests, may not silently skip or fail gracefully, and failures must be fixed rather than skipped.

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

- Backend endpoints: API route in `app/api/`, schemas in `app/schemas/`, logic in `app/services/`. Persistent model changes require an Alembic migration; verify `upgrade head` and the rollback before handing off.
- Executor types live in `executors/`; scheduler/orchestration lives in `executor_manager/`.
- Knowledge Runtime serves internal RAG APIs on port 8200. The converter uses the `knowledge_conversion` Celery queue.
- Chat Shell supports `http`, `package`, and `cli` modes.
- For changed Backend or Executor critical paths, use the tracing helpers in `shared/telemetry/decorators.py` instead of creating uninstrumented asynchronous main flows.

## Security

- Never commit credentials or session files. Use environment configuration for secrets.
- Only expose client-safe frontend settings through the appropriate public environment variable convention.
- Do not log tokens, API keys, or the contents of local authentication files.

## Common ports

`frontend` 3000, `backend` 8000, `chat_shell` 8001, `knowledge_runtime` 8200, MySQL 3306, Redis 6379.
