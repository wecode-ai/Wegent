## Summary

- Require admin authentication for the public model create, update, delete, and bulk upsert endpoints.
- Add focused API tests proving ordinary users receive 403 while admins retain compatibility access.

## Root cause

The legacy `/api/models` write endpoints only required an authenticated user, but their service layer writes shared public models (`user_id=0`, `namespace=default`). Any logged-in user could therefore modify or delete a global model configuration.

## Testing

- `uv run pytest tests/api/test_public_model_write_auth.py`
- `uvx ruff@0.14.1 check app/api/endpoints/adapter/models.py tests/api/test_public_model_write_auth.py`

## Security impact

This closes the unauthorized public model write path that could redirect model traffic through attacker-controlled `env.base_url` values or delete shared models. Read access and the existing admin public-model endpoints are unchanged.

No internal-only changes are included in this PR.
