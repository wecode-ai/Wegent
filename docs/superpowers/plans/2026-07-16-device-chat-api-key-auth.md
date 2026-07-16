---
sidebar_position: 1
---

# Device Chat Tasks API Key Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `POST /api/device-chat/tasks` to authenticate with the same personal API Key headers as existing executor-facing endpoints while preserving JWT behavior and downstream credential forwarding.

**Architecture:** Reuse `security.get_current_user_flexible_for_executor` at the endpoint boundary and centralize Authorization parsing in the shared security module. Keep downstream service interfaces unchanged, select the forwarded credential with the same `X-API-Key`-before-Authorization priority as the authentication dependency, and publish OAuth2/API Key OpenAPI security declarations.

**Tech Stack:** FastAPI dependencies and headers, SQLAlchemy-backed personal API Key verification, pytest, FastAPI TestClient

---

## File Structure

- Modify `backend/tests/api/endpoints/test_device_chat_tasks_api.py` to add endpoint-level API Key authentication and credential-forwarding regression coverage.
- Modify `backend/app/core/security.py` to share case-insensitive Bearer/plain-token parsing and expose both authentication schemes in OpenAPI.
- Modify `backend/app/api/endpoints/device_chat_tasks.py` to reuse flexible authentication and forward the credential selected by that authentication path.

### Task 1: Add failing Device Chat API Key endpoint tests

**Files:**

- Modify: `backend/tests/api/endpoints/test_device_chat_tasks_api.py`
- Test: `backend/tests/api/endpoints/test_device_chat_tasks_api.py`

- [ ] **Step 1: Extract the existing task-service mock into a reusable test helper**

Add module-level imports and a helper, then make the existing JWT dispatch test call the helper:

```python
from unittest.mock import AsyncMock

from app.schemas.device_chat_task import DeviceChatTaskResponse


def _mock_create_device_chat_task(monkeypatch) -> AsyncMock:
    from app.api.endpoints import device_chat_tasks

    service_mock = AsyncMock(
        return_value=DeviceChatTaskResponse(
            taskId=2267,
            userSubtaskId=3332,
            assistantSubtaskId=3333,
            messageId=5,
            aiTriggered=True,
            deviceId="device-1",
            chatUrl="/devices/chat?taskId=2267",
        )
    )
    monkeypatch.setattr(
        device_chat_tasks.device_chat_task_service,
        "create_device_chat_task",
        service_mock,
    )
    return service_mock
```

Replace the inline `AsyncMock` setup in
`test_create_device_chat_task_endpoint_dispatches_payload` with:

```python
service_mock = _mock_create_device_chat_task(monkeypatch)
```

- [ ] **Step 2: Add API Key authentication and forwarding tests**

Add these endpoint tests:

```python
def test_create_device_chat_task_endpoint_accepts_x_api_key(
    test_client,
    test_api_key,
    monkeypatch,
):
    raw_key, api_key_record = test_api_key
    service_mock = _mock_create_device_chat_task(monkeypatch)

    response = test_client.post(
        "/api/device-chat/tasks",
        headers={"X-API-Key": raw_key},
        json={"teamId": 1289, "message": "Run pwd"},
    )

    assert response.status_code == 200
    assert service_mock.await_args.kwargs["user"].id == api_key_record.user_id
    assert service_mock.await_args.kwargs["auth_token"] == raw_key


def test_create_device_chat_task_endpoint_accepts_bearer_api_key(
    test_client,
    test_api_key,
    monkeypatch,
):
    raw_key, api_key_record = test_api_key
    service_mock = _mock_create_device_chat_task(monkeypatch)

    response = test_client.post(
        "/api/device-chat/tasks",
        headers={"Authorization": f"Bearer {raw_key}"},
        json={"teamId": 1289, "message": "Run pwd"},
    )

    assert response.status_code == 200
    assert service_mock.await_args.kwargs["user"].id == api_key_record.user_id
    assert service_mock.await_args.kwargs["auth_token"] == raw_key


def test_create_device_chat_task_endpoint_prefers_x_api_key_for_forwarding(
    test_client,
    test_token,
    test_api_key,
    monkeypatch,
):
    raw_key, _ = test_api_key
    service_mock = _mock_create_device_chat_task(monkeypatch)

    response = test_client.post(
        "/api/device-chat/tasks",
        headers={
            "Authorization": f"Bearer {test_token}",
            "X-API-Key": raw_key,
        },
        json={"teamId": 1289, "message": "Run pwd"},
    )

    assert response.status_code == 200
    assert service_mock.await_args.kwargs["auth_token"] == raw_key


def test_create_device_chat_task_endpoint_rejects_invalid_api_key(
    test_client,
    monkeypatch,
):
    service_mock = _mock_create_device_chat_task(monkeypatch)

    response = test_client.post(
        "/api/device-chat/tasks",
        headers={"X-API-Key": "wg-invalid-api-key"},
        json={"teamId": 1289, "message": "Run pwd"},
    )

    assert response.status_code == 401
    service_mock.assert_not_awaited()
```

- [ ] **Step 3: Run the new successful API Key cases and verify RED**

Run:

```bash
cd backend && uv run pytest \
  tests/api/endpoints/test_device_chat_tasks_api.py::test_create_device_chat_task_endpoint_accepts_x_api_key \
  tests/api/endpoints/test_device_chat_tasks_api.py::test_create_device_chat_task_endpoint_accepts_bearer_api_key \
  tests/api/endpoints/test_device_chat_tasks_api.py::test_create_device_chat_task_endpoint_prefers_x_api_key_for_forwarding \
  -q
```

Expected: all three tests fail for the missing feature. The first two receive `401` instead of `200`; the priority case forwards the JWT instead of the API Key.

### Task 2: Reuse flexible authentication and forward the selected credential

**Files:**

- Modify: `backend/app/core/security.py`
- Modify: `backend/app/api/endpoints/device_chat_tasks.py`
- Test: `backend/tests/api/endpoints/test_device_chat_tasks_api.py`

- [ ] **Step 1: Use the existing flexible authentication dependency**

Add shared Authorization parsing and expose the existing optional OAuth2/API Key
schemes from the flexible dependency:

```python
def extract_authorization_token(authorization: Optional[str]) -> str:
    """Extract a case-insensitive Bearer credential or return a plain token."""
    scheme, token = get_authorization_scheme_param(authorization)
    if scheme.lower() == "bearer":
        return token
    return authorization or ""


def get_current_user_flexible_for_executor(
    db: Session = Depends(get_db),
    oauth2_token: Optional[str] = Security(oauth2_scheme_optional),
    x_api_key_security: Optional[str] = Security(api_key_header_optional),
    authorization: str = Header(default="", include_in_schema=False),
    x_api_key: str = Header(
        default="",
        alias="X-API-Key",
        include_in_schema=False,
    ),
) -> User:
```

Import the existing API Key detector in the endpoint:

```python
from app.core.auth_utils import is_api_key
```

Update the endpoint parameters and dependency:

```python
async def create_device_chat_task(
    payload: DeviceChatTaskRequest,
    authorization: Annotated[
        str | None,
        Header(include_in_schema=False),
    ] = None,
    x_api_key: Annotated[
        str | None,
        Header(alias="X-API-Key", include_in_schema=False),
    ] = None,
    current_user: User = Depends(
        security.get_current_user_flexible_for_executor
    ),
    db: Session = Depends(get_db),
) -> DeviceChatTaskResponse:
```

- [ ] **Step 2: Select and forward the credential used for authentication**

Pass both request headers to a focused helper:

```python
return await device_chat_task_service.create_device_chat_task(
    db=db,
    user=current_user,
    request=payload,
    auth_token=_request_auth_token(authorization, x_api_key),
)
```

Add the helper using the same shared Authorization parser as the dependency:

```python
def _request_auth_token(
    authorization: str | None,
    x_api_key: str | None,
) -> str:
    if x_api_key and is_api_key(x_api_key):
        return x_api_key
    return security.extract_authorization_token(authorization)
```

This mirrors the existing authentication priority and prevents an arbitrary
non-API-Key header from overriding an authenticated JWT.

- [ ] **Step 3: Run the focused endpoint suite and verify GREEN**

Run:

```bash
cd backend && uv run pytest tests/api/endpoints/test_device_chat_tasks_api.py -q
```

Expected: all Device Chat Tasks endpoint tests pass, including JWT compatibility,
both API Key header forms, plain credentials, priority, OpenAPI security, missing
credentials, and invalid credentials.

- [ ] **Step 4: Run related authentication regression tests**

Run:

```bash
cd backend && uv run pytest \
  tests/api/endpoints/test_device_chat_tasks_api.py \
  tests/api/test_executor_api_key_auth.py \
  tests/core/test_security.py \
  tests/core/test_auth_utils.py \
  -q
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 5: Check formatting and the final diff**

Run:

```bash
cd backend && uv run black --check \
  app/core/security.py \
  app/api/endpoints/device_chat_tasks.py \
  tests/api/endpoints/test_device_chat_tasks_api.py
cd backend && uv run isort --check-only \
  app/core/security.py \
  app/api/endpoints/device_chat_tasks.py \
  tests/api/endpoints/test_device_chat_tasks_api.py
git diff --check
git diff --stat
```

Expected: formatting checks and `git diff --check` exit successfully; the diff is limited to the endpoint and its endpoint tests.

- [ ] **Step 6: Commit the implementation**

```bash
git add \
  backend/app/core/security.py \
  backend/app/api/endpoints/device_chat_tasks.py \
  backend/tests/api/endpoints/test_device_chat_tasks_api.py
git commit -m "fix(auth): support API keys for device chat tasks"
```
