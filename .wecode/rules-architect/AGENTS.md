# Architect Mode Rules (Non-Obvious Only)

## Critical Architecture Constraints

### Service Coupling
- Backend, executor, and executor_manager are tightly coupled via HTTP callbacks
- Changing ports requires updates in multiple hardcoded locations
- Services must start in order: database → backend → executor_manager → executor

### Database Design Gotchas
- No migration rollback support - forward-only schema changes
- Agent configurations stored as JSON strings in `public_model` table, not normalized
- Task status transitions managed by `subtask.py` - direct DB updates break state machine

### Build System Complexity
- Docker builds copy from `wecode/docker/*/` at build time - source changes ignored
- Mac ARM requires separate build script (`build_image_mac.sh`)
- Three separate `requirements.txt` files - no shared dependency management

### Authentication Architecture
- Dual system: local auth + OIDC (GitLab/GitHub)
- WeCode patches override entire endpoints, not extend them
- Token resolution through custom `token_resolver.py` for git operations

### Frontend Constraints
- Next.js 15 App Router - no Pages Router compatibility
- No state management libraries - React hooks only
- API proxy required (`/api/proxy`) for all backend calls

### Scaling Limitations
- Executor runs with `--network host` - container isolation broken
- No horizontal scaling for executor_manager - single instance only
- Database connection pooling not configured - each service creates direct connections