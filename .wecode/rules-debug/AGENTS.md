# Debug Mode Rules (Non-Obvious Only)

## Critical Debugging Patterns

### Service Communication Issues
- Executor callbacks fail silently if ports mismatch - check `--callback-url` parameter
- Docker containers need `--network host` for local debugging
- Service logs split across three processes: backend, executor, executor_manager

### Database State Debugging
- Task status in `subtask` table - check `status` and `result` columns
- Agent configs in `public_model` table stored as JSON strings - use `jsonb` queries
- Failed tasks leave orphaned Docker containers - manual cleanup required

### Frontend Debugging
- Next.js dev server on port 3000, API proxy adds `/api/proxy` prefix
- Browser console won't show backend errors - check backend logs separately
- i18n missing keys fail silently - check network tab for 404s on locale files

### Docker Build Issues
- Build context copies from `wecode/docker/*/` - changes in source won't appear
- Mac M1/M2 must use `build_image_mac.sh` or builds fail with platform errors
- Missing `.env` files cause cryptic startup failures - check `.env.example` for required vars

### Agent Execution Tracing
- Executor logs to stdout, not files - use `docker logs` for container output
- Agent registration failures in `factory.py` throw generic "not found" errors
- MCP server connections fail silently - check `executor/agents/agno/mcp_manager.py` logs