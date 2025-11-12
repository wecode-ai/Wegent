# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Critical Non-Obvious Patterns

### Multi-Service Architecture
- **Three separate services** must be running: backend (FastAPI), executor, executor_manager
- Services communicate via HTTP callbacks - executor calls back to backend/executor_manager
- Each service has its own requirements.txt - dependencies are NOT shared

### Build System Gotchas
- **Mac builds require `build_image_mac.sh`** - regular `build_image.sh` will fail on ARM Macs
- Build scripts copy files from `wecode/docker/*/` to build context - modifications in source won't reflect without rebuild
- Frontend builds require `.env.local` with `NEXT_PUBLIC_API_URL` pointing to backend

### Database Requirements
- PostgreSQL with `init.sql` must run before backend starts
- WeCode variant uses `wecode/init_data.sql` for additional initialization
- Database migrations are forward-only - no rollback support

### Agent System Architecture
- Agents (Agno, ClaudeCode) are dynamically loaded via factory pattern in `executor/agents/factory.py`
- Agent configurations stored as JSON in database `public_model` table
- Task kinds (`bot_kinds.py`, `task_kinds.py`, `team_kinds.py`) define available agent types

### Authentication Complexity
- Dual auth system: local users + OIDC (GitLab/GitHub)
- WeCode patches in `backend/wecode/api/` override open-source endpoints
- Token resolution happens through `wecode/service/token_resolver.py` for git operations

### Docker Execution Constraints
- Executor containers run with `--network host` for callback access
- K8s executor uses pod templates from `wecode/executors/k8s/pod_template.yaml`
- Container names must follow pattern from `executor_manager/utils/executor_name.py`

### Frontend Routing
- Next.js 15 with App Router - pages in `src/app/`
- API calls go through `/api/proxy` to avoid CORS
- i18n uses separate locale files per feature in `src/i18n/locales/`

## Commands (Non-Standard Only)

```bash
# Backend with WeCode patches (from backend/)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Executor with callback URL (from executor/)
python main.py --callback-url http://localhost:8000

# Build for Mac M1/M2
./build_image_mac.sh

# Initialize database with WeCode data
psql -U postgres -d wegent < backend/wecode/init_data.sql