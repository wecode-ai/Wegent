---
sidebar_position: 39
---

# Wework Cloud Model Proxy Gateway

The Wework desktop client and the Wegent backend may run on different machines. When the desktop client uses a Model CRD with real cloud provider credentials, the provider `api_key` must remain on the backend while Codex can still call the cloud model.

## Solution

Wework builds proxy model config directly from the configured cloud URL and login token. Wegent then calls the real provider on behalf of Wework.

### Key Components

- `app/services/llm_proxy_service.py`: resolves model identity, checks access, and forwards provider requests.
- `POST /api/runtime-work/llm-responses-proxy/responses`: proxy endpoint authenticated with the user's login token.
- `/models/unified`: returns the model name, type, namespace, and resource owner ID needed to identify the Model CRD exactly.

### Request Flow

1. Wework fetches credential-free model metadata from `/models/unified`.
2. Wework directly builds proxy config: `base_url` is `/api/runtime-work/llm-responses-proxy` under the configured cloud URL, and `api_key` is the current cloud login token.
3. The executor Codex compatibility proxy authenticates to the backend with that token and sends the model type, namespace, and resource owner ID.
4. The backend validates the login token and model access, then resolves the Model CRD by `user_id + namespace + name`.
5. The backend loads the real provider configuration, replaces the request model with the provider `model_id`, and streams the request and response.

## Security Benefits

- The Wework desktop client and local executor never receive the real provider `api_key`.
- The model proxy uses the same authentication and expiration policy as other backend APIs.
- Real provider credentials remain in backend memory and the database only.

## Related Implementation

- The executor Codex compatibility proxy puts the login token in the backend request's `Authorization: Bearer` header.
- The backend resolves models by complete resource identity so same-named personal, public, and group models cannot use one another's configuration.
- Wework uses the same direct proxy config for task creation, follow-up messages, and rollback without a separate model-config resolution request.
