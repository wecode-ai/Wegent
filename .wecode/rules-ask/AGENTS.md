# Ask Mode Rules (Non-Obvious Only)

## Critical Documentation Context

### Misleading Directory Structure
- `backend/wecode/` contains production overrides, not optional extensions
- `shared/` utilities are mandatory dependencies for all services
- `executor/wecode/` has critical hooks that modify agent behavior

### Configuration Hierarchy
- WeCode patches in `backend/wecode/api/` completely replace base endpoints
- Agent configs in database override file-based configurations
- Environment variables in `.env.example` are required, not optional examples

### Hidden Dependencies
- Frontend requires backend on port 8000, executor_manager on 8001
- Executor needs callback URL to backend for status updates
- Database must be initialized with both `init.sql` AND `wecode/init_data.sql`

### Non-Obvious Naming
- "public_model" table stores agent configurations, not public data models
- "bot_kinds" defines single agents, "team_kinds" defines agent teams
- "task_kinds" maps to UI task types, not internal processing

### Architectural Constraints
- No testing framework configured - project relies on Docker integration tests
- Frontend uses Next.js App Router (v15), not Pages Router
- i18n translations split per feature, not centralized