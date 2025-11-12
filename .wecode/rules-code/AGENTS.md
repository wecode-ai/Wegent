# Code Mode Rules (Non-Obvious Only)

## Critical Implementation Patterns

### Service Dependencies
- Backend imports from `wecode/` override base implementations - check both locations
- Executor agents must register in `executor/agents/factory.py` with exact class name matching
- Shared utilities in `shared/` are used by ALL services - changes affect multiple components

### Database Access
- Direct SQL forbidden - use SQLAlchemy models in `backend/app/models/`
- Task status updates MUST go through `backend/app/services/subtask.py` for proper state management
- Public models stored as JSON strings in database - parse before use

### API Endpoints
- WeCode patches completely replace endpoints - don't modify base files in `backend/app/api/endpoints/`
- Executor callbacks use different ports: backend (8000), executor_manager (8001)
- Authentication headers required even for internal service calls

### Frontend State
- No Redux/Zustand - React hooks only due to webview restrictions
- API calls must use `/api/proxy` prefix to route through Next.js middleware
- Translations loaded per-feature, not globally - check `src/i18n/locales/[lang]/[feature].json`

### Docker Build Context
- Files copied from `wecode/docker/*/` during build - source edits won't reflect
- Environment variables in `.env.example` are NOT defaults - must create actual `.env`
- Frontend requires separate `.env.local` with `NEXT_PUBLIC_` prefix for client-side vars