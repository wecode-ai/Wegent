---
sidebar_position: 39
---

# Wework Cloud Model Proxy Gateway

The Wework desktop client and the Wegent backend may run on different machines. When the desktop client uses a Model CRD that contains real cloud provider credentials, the `api_key` must not be sent to the local machine, while Codex still needs to call the cloud model successfully.

## Problem

- Model CRDs store real `base_url`, `api_key`, and `model_id` in `spec.modelConfig.env`.
- Wework fetches runtime model config through `/runtime-work/resolve-model-config`.
- Returning the real credentials to the desktop would move sensitive material outside the controlled server environment.
- Earlier fixes taught the executor and Wework how to recognize cloud model config, but they did not fully isolate the credentials.

## Solution

Introduce a backend LLM proxy gateway: Wework sends only user input and model selection to Wegent, and Wegent calls the real provider on behalf of Wework.

### Key Components

- `app/services/llm_proxy_service.py`: core proxy service.
- `POST /api/runtime-work/llm-responses/responses`: proxy endpoint.
- `app/services/chat/trigger/unified.py` and `runtime_work_service.py`: decide whether to use proxy mode based on model config.

### Request Flow

1. Wework calls `/runtime-work/resolve-model-config`.
2. If the model has real provider credentials, the backend:
   - Generates an encrypted Fernet proxy token containing user ID, model namespace/name, issued-at/expiration times, and a unique `jti`.
   - Derives a per-token HMAC signing key from the token `jti` and a master signing key.
   - Returns `base_url` pointing to the backend proxy endpoint, `api_key` set to the proxy token, `signing_key` set to the per-token signing key, and `codex_responses_compat_proxy: true`.
3. The Wework/executor Codex compat proxy sends requests to that `base_url` with:
   - `Authorization: Bearer {proxy_token}`
   - `X-Wegent-Request-Nonce: {uuid}`
   - `X-Wegent-Body-Signature: {hex(HMAC-SHA256(signing_key, nonce + body))}`
4. The backend decrypts the token, verifies the nonce has not been used, verifies the HMAC signature, resolves the Model CRD, and extracts the real `base_url`, `api_key`, and `model_id`.
5. The backend forwards the request to the real provider and streams the response back to Wework.

## Key Management

### Encryption Key

Proxy tokens use Fernet symmetric encryption. Key resolution priority:

1. `LLM_PROXY_TOKEN_KEY` environment variable.
2. `SystemConfig` entry `llm_proxy_token_key`; auto-generated and persisted if absent.
3. Deterministic dev/test fallback when no database or env key is available.

### Signing Key

Request-body HMAC signatures use a master signing key. Key resolution priority:

1. `LLM_PROXY_SIGNING_KEY` environment variable.
2. `SystemConfig` entry `llm_proxy_signing_key`; auto-generated and persisted if absent.
3. Deterministic dev/test fallback when no database or env key is available.

Per-token signing keys are derived as `HMAC-SHA256(master_signing_key, token_jti)` and returned only to the local executor.

Production deployments do not need to set `LLM_PROXY_TOKEN_KEY` or `LLM_PROXY_SIGNING_KEY` manually; the backend generates and persists keys on first use.

## Security Benefits

- The Wework desktop client and local executor never receive the real `api_key`.
- Proxy tokens are bound to a user and a model CRD and expire after a configurable TTL.
- Tokens are no longer placed in URLs, so they do not appear in access logs, browser history, or proxy logs.
- Every proxied request must carry a unique nonce and a valid body signature; replaying a captured request fails because the nonce is tracked in Redis until the token expires.
- Real provider credentials remain in backend memory and the database only.

## Related Changes

- Executor passes third-party Model CRD config into the local Codex binary and resolves `model_id` from CRD env instead of CRD name.
- Backend resolves cloud model config for desktop runtime tasks and fixes the response key.
- Backend adds an encrypted Codex responses proxy gateway with request signing and replay protection.
- Wework side wires runtime model resolution with the cloud authorization flow.
