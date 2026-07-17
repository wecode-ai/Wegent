---
sidebar_position: 1
---

# Wework Sites Project API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Wework Sites list, search, publish, delete, and rename behavior to the authenticated `/v1/projects/*` service without exposing the upstream token to Wework.

**Architecture:** Wework continues to call the authenticated Wegent Backend `/api/v1/sites` gateway. Backend reads `SITES_API_BASE_URL` and a masked `SITES_API_TOKEN`, injects the authenticated Wegent username, translates gateway operations to the new project API, validates responses, and maps upstream authentication failures to a non-401 gateway error. Wework consumes the real project model and cursor pagination, and reuses `TextInputDialog` for renaming.

**Tech Stack:** FastAPI, Pydantic v2, httpx, pytest/httpx-mock, React 19, TypeScript 6, Vitest, Testing Library, Tauri verification tooling

---

## 文件结构

- `backend/app/core/config.py`：增加仅供 Backend 使用的敏感 Sites Token 配置。
- `backend/app/schemas/site.py`：用新项目、cursor 列表、删除确认和重命名请求模型替换旧站点发布模型。
- `backend/app/services/sites.py`：唯一的上游协议适配层，负责认证头、四个 `/v1/projects/*` 请求、响应验证和上游错误解析。
- `backend/app/api/endpoints/sites.py`：保持 Wework 网关路径稳定，注入当前登录用户名并将上游认证错误隔离为 502。
- `backend/tests/api/test_sites_api.py`：覆盖新上游请求、Token 安全边界、cursor、变更接口和错误映射。
- `.env.example`、`backend/.env.example`、`docker-compose.yml`：声明 `SITES_API_TOKEN`，删除旧 8765 服务提示。
- `wework/src/api/sites.ts`：Wework 的新项目类型和 Backend 网关客户端。
- `wework/src/api/sites.test.ts`：验证 cursor 及发布、删除、重命名请求。
- `wework/src/components/sites/SitesWorkspace.tsx`：cursor 状态、项目网络状态、请求中状态及可恢复错误。
- `wework/src/components/sites/SiteActionsMenu.tsx`：加入重命名操作。
- `wework/src/components/sites/DeleteSiteDialog.tsx`：改用新项目字段并保持删除失败可重试。
- `wework/src/components/common/TextInputDialog.tsx`：增加可选 `maxLength`，供站点重命名复用。
- `wework/src/components/common/TextInputDialog.test.tsx`：验证最大长度透传。
- `wework/src/components/sites/SitesWorkspace.test.tsx`：覆盖新模型、cursor、发布、重命名和删除冲突。
- `wework/src/i18n/locales/zh-CN/sites.json`、`wework/src/i18n/locales/en/sites.json`：同步新网络和重命名文案，删除不再使用的旧发布字段文案。
- `wework/src/App.plugins.test.tsx`：更新页面级 Sites fixture 和网关请求断言。

## Task 1: Backend 配置、项目模型和 cursor 搜索

**Files:**
- Modify: `backend/app/core/config.py:7-15,225-227`
- Modify: `backend/app/schemas/site.py:5-39`
- Modify: `backend/app/services/sites.py:5-142`
- Modify: `backend/app/api/endpoints/sites.py:7-77`
- Modify: `backend/tests/api/test_sites_api.py:5-92`
- Modify: `.env.example:132-135`
- Modify: `backend/.env.example:69-71`
- Modify: `docker-compose.yml:98`

- [ ] **Step 1: 写出配置缺失、Bearer 头和 cursor 搜索的失败测试**

将 `backend/tests/api/test_sites_api.py` 的旧站点 helper 和列表测试替换为以下项目契约测试；变更接口测试留到 Task 2：

```python
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import settings

SITES_API_BASE_URL = "https://sites.example.test"
SITES_API_TOKEN = "sites-platform-test-token"


def _project(**overrides: Any) -> dict[str, Any]:
    project = {
        "id": "prj_01KXN31C03C3MVD878RPP1PFX7",
        "network": "inner",
        "title": "Product site",
        "url": "https://product.inner.example.test/",
        "snapshot": "https://cdn.example.test/product.png",
        "created_at": "2026-07-16T09:10:03.865Z",
    }
    project.update(overrides)
    return project


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _configure_sites(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    monkeypatch.setattr(
        settings,
        "SITES_API_TOKEN",
        SecretStr(SITES_API_TOKEN),
    )


def test_list_sites_requires_authentication(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_sites(monkeypatch)

    response = test_client.get("/api/v1/sites")

    assert response.status_code == 401


@pytest.mark.parametrize(
    ("base_url", "upstream_token"),
    [("", SITES_API_TOKEN), (SITES_API_BASE_URL, "")],
)
def test_list_sites_returns_not_available_when_configuration_is_incomplete(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    base_url: str,
    upstream_token: str,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", base_url)
    monkeypatch.setattr(settings, "SITES_API_TOKEN", SecretStr(upstream_token))

    response = test_client.get(
        "/api/v1/sites",
        headers=_authorization(test_token),
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "sites_not_available"


def test_list_sites_injects_username_token_query_and_cursor(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/v1/projects/search"
            "?username=testuser&sitename=product&limit=10"
            "&cursor=prj_01KXN31C03C3MVD878RPP1PFX7"
        ),
        json={
            "items": [_project()],
            "next_cursor": "prj_01KXN31C04GR4MZ72K98QBS6PX",
        },
    )

    response = test_client.get(
        "/api/v1/sites",
        params={
            "q": " product ",
            "cursor": "prj_01KXN31C03C3MVD878RPP1PFX7",
            "limit": 10,
        },
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json() == {
        "items": [_project()],
        "next_cursor": "prj_01KXN31C04GR4MZ72K98QBS6PX",
    }
    upstream_request = httpx_mock.get_requests()[0]
    assert upstream_request.headers["Authorization"] == (
        f"Bearer {SITES_API_TOKEN}"
    )
    assert "sites-platform-test-token" not in repr(settings.SITES_API_TOKEN)


def test_list_sites_sends_empty_sitename_without_cursor(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/v1/projects/search"
            "?username=testuser&sitename=&limit=20"
        ),
        json={"items": [], "next_cursor": None},
    )

    response = test_client.get(
        "/api/v1/sites",
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json() == {"items": [], "next_cursor": None}


def test_list_sites_rejects_an_invalid_upstream_project_payload(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/v1/projects/search"
            "?username=testuser&sitename=&limit=20"
        ),
        json={"items": [{"id": "missing-fields"}], "next_cursor": None},
    )

    response = test_client.get(
        "/api/v1/sites",
        headers=_authorization(test_token),
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "sites_upstream_unavailable"
```

- [ ] **Step 2: 运行 Backend 列表测试并确认 RED**

Run:

```bash
cd backend && uv run pytest tests/api/test_sites_api.py -q
```

Expected: FAIL，因为 `SITES_API_TOKEN`、新项目字段、cursor 参数和
`/v1/projects/search` 尚未实现；失败不得来自测试导入或语法错误。

- [ ] **Step 3: 实现敏感配置和新项目 schema**

在 `backend/app/core/config.py` 从 Pydantic 导入 `SecretStr`，并在 Sites 配置旁加入：

```python
from pydantic import SecretStr, field_validator

# Optional upstream for the Sites service. Wework accesses it through Backend.
SITES_API_BASE_URL: str = ""
SITES_API_TOKEN: SecretStr = SecretStr("")
```

将 `backend/app/schemas/site.py` 替换为：

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas exchanged with the external Sites project service."""

from datetime import datetime
from typing import Literal

from pydantic import AnyHttpUrl, BaseModel, Field, field_validator

SiteNetwork = Literal["inner", "outer"]


class SiteResponse(BaseModel):
    """A Sites project owned by the authenticated user."""

    id: str
    network: SiteNetwork
    title: str
    url: AnyHttpUrl
    snapshot: AnyHttpUrl
    created_at: datetime


class SiteListResponse(BaseModel):
    """A cursor page of Sites projects."""

    items: list[SiteResponse]
    next_cursor: str | None = None


class SiteDeleteResponse(BaseModel):
    """Confirmation returned by the upstream delete operation."""

    deleted: bool


class SiteRenameRequest(BaseModel):
    """Validated gateway request for changing a site title."""

    title: str = Field(min_length=1, max_length=255)

    @field_validator("title")
    @classmethod
    def strip_title(cls, value: str) -> str:
        title = value.strip()
        if not title:
            raise ValueError("title must not be empty")
        return title
```

- [ ] **Step 4: 实现仅包含搜索的新上游适配和网关路由**

在 `backend/app/services/sites.py` 删除 `quote` 和旧 get/publish/delete 实现，加入
安全配置、认证头、项目验证和 cursor 搜索。Task 1 完成时文件的核心实现应为：

```python
from typing import Any

import httpx
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.site import SiteListResponse, SiteResponse
from shared.telemetry.decorators import trace_async


class SitesNotAvailableError(RuntimeError):
    """Raised when the Sites integration is not configured."""


class SitesUpstreamAuthenticationError(RuntimeError):
    """Raised when the server-owned Sites token is rejected."""


class SitesUpstreamUnavailableError(RuntimeError):
    """Raised when Sites cannot return a valid response."""


class SitesUpstreamResponseError(RuntimeError):
    """Raised when Sites returns an application HTTP error."""

    def __init__(self, status_code: int, detail: Any) -> None:
        super().__init__(f"Sites service returned HTTP {status_code}")
        self.status_code = status_code
        self.detail = detail


class SitesService:
    """Call Sites with server-controlled credentials and user identity."""

    def __init__(self, timeout_seconds: float = 10.0) -> None:
        self._timeout_seconds = timeout_seconds

    @staticmethod
    def _configuration() -> tuple[str, str]:
        base_url = settings.SITES_API_BASE_URL.strip().rstrip("/")
        token = settings.SITES_API_TOKEN.get_secret_value().strip()
        if not base_url or not token:
            raise SitesNotAvailableError("Sites is not configured")
        return base_url, token

    @trace_async(
        "sites.upstream.request",
        "backend.sites",
        extract_attributes=lambda self, method, path, **kwargs: {
            "http.request.method": method,
            "http.route": path,
        },
    )
    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        base_url, token = self._configuration()
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.request(
                    method,
                    f"{base_url}{path}",
                    params=params,
                    json=json_body,
                    headers={"Authorization": f"Bearer {token}"},
                )
        except SitesNotAvailableError:
            raise
        except httpx.RequestError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service is unavailable"
            ) from exc

        if response.status_code == 401:
            raise SitesUpstreamAuthenticationError("Sites token was rejected")
        if response.is_error:
            raise SitesUpstreamResponseError(
                response.status_code,
                self._response_detail(response),
            )
        try:
            return response.json()
        except ValueError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid response"
            ) from exc

    @staticmethod
    def _response_detail(response: httpx.Response) -> Any:
        try:
            payload = response.json()
        except ValueError:
            return response.text or f"Sites request failed: HTTP {response.status_code}"
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                return error
            if "detail" in payload:
                return payload["detail"]
        return payload

    async def list_sites(
        self,
        *,
        username: str,
        query: str,
        cursor: str | None,
        limit: int,
    ) -> SiteListResponse:
        params: dict[str, Any] = {
            "username": username,
            "sitename": query,
            "limit": limit,
        }
        if cursor:
            params["cursor"] = cursor
        payload = await self._request("GET", "/v1/projects/search", params=params)
        try:
            return SiteListResponse.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid project list"
            ) from exc

    @staticmethod
    def _validate_site(payload: Any) -> SiteResponse:
        try:
            return SiteResponse.model_validate(payload)
        except ValidationError as exc:
            raise SitesUpstreamUnavailableError(
                "Sites service returned an invalid project"
            ) from exc


sites_service = SitesService()
```

在 `backend/app/api/endpoints/sites.py` 导入
`SitesUpstreamAuthenticationError`，在 `_raise_sites_error` 中加入下列分支，并把列表
路由改成 cursor 参数：

```python
if isinstance(error, SitesUpstreamAuthenticationError):
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail={
            "code": "sites_upstream_auth_failed",
            "message": "Sites service authentication failed",
        },
    ) from error


@router.get("", response_model=SiteListResponse)
async def list_sites(
    q: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(security.get_current_user),
) -> SiteListResponse:
    """List Sites projects owned by the authenticated user."""
    try:
        return await sites_service.list_sites(
            username=current_user.user_name,
            query=q.strip() if q else "",
            cursor=cursor,
            limit=limit,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamAuthenticationError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)
```

暂时删除旧 `_ensure_site_owner`、publish 和 delete 路由；Task 2 会在测试先行后恢复
对应的新协议实现。

- [ ] **Step 5: 更新环境配置样例与 Docker 透传**

将两个 env example 的 Sites 段落改为明确的安全配置：

```dotenv
# Optional authenticated Sites project API. Wegent Backend injects the current
# username and keeps the platform token out of Wework. Leave either value empty
# to disable Sites in Wework.
SITES_API_BASE_URL=
SITES_API_TOKEN=
```

在 `docker-compose.yml` 的 Backend environment 中紧邻 base URL 加入：

```yaml
SITES_API_BASE_URL: ${SITES_API_BASE_URL:-}
SITES_API_TOKEN: ${SITES_API_TOKEN:-}
```

不要把测试地址设为默认值，不要把任何真实 Token 写入跟踪文件。

- [ ] **Step 6: 运行 Backend 列表测试并确认 GREEN**

Run:

```bash
cd backend && uv run pytest tests/api/test_sites_api.py -q
```

Expected: PASS，且测试输出中不出现 Bearer Token。

- [ ] **Step 7: 提交 Backend 搜索迁移**

```bash
git add .env.example backend/.env.example docker-compose.yml backend/app/core/config.py backend/app/schemas/site.py backend/app/services/sites.py backend/app/api/endpoints/sites.py backend/tests/api/test_sites_api.py
git commit -m "feat(backend): migrate Sites search to project API"
```

## Task 2: Backend 发布、删除、重命名与错误映射

**Files:**
- Modify: `backend/app/services/sites.py`
- Modify: `backend/app/api/endpoints/sites.py`
- Modify: `backend/tests/api/test_sites_api.py`

- [ ] **Step 1: 写出三个变更接口和上游认证隔离的失败测试**

向 `backend/tests/api/test_sites_api.py` 追加：

```python
def test_publish_site_uses_username_and_project_id(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    project_id = "prj_01KXN31C03C3MVD878RPP1PFX7"
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/v1/projects/deploy/outer",
        json=_project(
            network="outer",
            url="https://product.outer.example.test",
        ),
    )

    response = test_client.post(
        f"/api/v1/sites/{project_id}/publish",
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json()["network"] == "outer"
    assert httpx_mock.get_requests()[0].read().decode() == (
        '{"username":"testuser","project_id":"'
        f'{project_id}'
        '"}'
    )


def test_delete_site_returns_204_only_after_upstream_confirmation(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    project_id = "prj_01KXN31C03C3MVD878RPP1PFX7"
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/v1/projects/del",
        json={"deleted": True},
    )

    response = test_client.delete(
        f"/api/v1/sites/{project_id}",
        headers=_authorization(test_token),
    )

    assert response.status_code == 204
    assert response.content == b""
    assert httpx_mock.get_requests()[0].read().decode() == (
        '{"username":"testuser","project_id":"'
        f'{project_id}'
        '"}'
    )


def test_delete_site_rejects_unconfirmed_success_payload(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    project_id = "prj_01KXN31C03C3MVD878RPP1PFX7"
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/v1/projects/del",
        json={"deleted": False},
    )

    response = test_client.delete(
        f"/api/v1/sites/{project_id}",
        headers=_authorization(test_token),
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "sites_upstream_unavailable"


def test_rename_site_trims_title_and_returns_updated_project(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    project_id = "prj_01KXN31C03C3MVD878RPP1PFX7"
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/v1/projects/update",
        json=_project(title="Renamed site"),
    )

    response = test_client.post(
        f"/api/v1/sites/{project_id}/rename",
        json={"title": "  Renamed site  "},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json()["title"] == "Renamed site"
    assert httpx_mock.get_requests()[0].read().decode() == (
        '{"username":"testuser","project_id":"'
        f'{project_id}'
        '","sitename":"Renamed site"}'
    )


@pytest.mark.parametrize("title", ["", "   ", "x" * 256])
def test_rename_site_rejects_invalid_title_without_calling_upstream(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
    title: str,
) -> None:
    _configure_sites(monkeypatch)

    response = test_client.post(
        "/api/v1/sites/prj_01KXN31C03C3MVD878RPP1PFX7/rename",
        json={"title": title},
        headers=_authorization(test_token),
    )

    assert response.status_code == 422
    assert httpx_mock.get_requests() == []


def test_upstream_auth_failure_does_not_become_wework_401(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/v1/projects/search"
            "?username=testuser&sitename=&limit=20"
        ),
        status_code=401,
        json={
            "error": {
                "code": "AUTHENTICATION_REQUIRED",
                "message": "Bearer token is invalid",
            }
        },
    )

    response = test_client.get(
        "/api/v1/sites",
        headers=_authorization(test_token),
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "sites_upstream_auth_failed"


def test_upstream_conflict_preserves_error_code_and_message(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/v1/projects/del",
        status_code=409,
        json={
            "error": {
                "code": "CONFLICT",
                "message": "Project still has associated resources",
            }
        },
    )

    response = test_client.delete(
        "/api/v1/sites/prj_01KXN31C03C3MVD878RPP1PFX7",
        headers=_authorization(test_token),
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "CONFLICT",
        "message": "Project still has associated resources",
    }
```

- [ ] **Step 2: 运行新增测试并确认 RED**

Run:

```bash
cd backend && uv run pytest tests/api/test_sites_api.py -q
```

Expected: FAIL，publish/delete 路由不存在或仍使用旧协议，rename 路由不存在。

- [ ] **Step 3: 实现三个上游变更方法**

在 `SitesService` 中加入：

```python
async def publish_site(self, *, username: str, project_id: str) -> SiteResponse:
    payload = await self._request(
        "POST",
        "/v1/projects/deploy/outer",
        json_body={"username": username, "project_id": project_id},
    )
    return self._validate_site(payload)

async def delete_site(self, *, username: str, project_id: str) -> None:
    payload = await self._request(
        "POST",
        "/v1/projects/del",
        json_body={"username": username, "project_id": project_id},
    )
    try:
        result = SiteDeleteResponse.model_validate(payload)
    except ValidationError as exc:
        raise SitesUpstreamUnavailableError(
            "Sites service returned an invalid delete response"
        ) from exc
    if not result.deleted:
        raise SitesUpstreamUnavailableError(
            "Sites service did not confirm project deletion"
        )

async def rename_site(
    self,
    *,
    username: str,
    project_id: str,
    title: str,
) -> SiteResponse:
    payload = await self._request(
        "POST",
        "/v1/projects/update",
        json_body={
            "username": username,
            "project_id": project_id,
            "sitename": title,
        },
    )
    return self._validate_site(payload)
```

同时把 `SiteDeleteResponse` 加到 `backend/app/services/sites.py` 的 schema imports。

- [ ] **Step 4: 实现新的 Backend 网关变更路由**

删除旧详情预查和 `_ensure_site_owner`，导入 `SiteRenameRequest`，用以下路由替换旧
publish/delete 实现并新增 rename：

```python
@router.post("/{project_id}/publish", response_model=SiteResponse)
async def publish_site(
    project_id: str,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Publish an owned Sites project to the public internet."""
    try:
        return await sites_service.publish_site(
            username=current_user.user_name,
            project_id=project_id,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamAuthenticationError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_site(
    project_id: str,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Delete an owned Sites project."""
    try:
        await sites_service.delete_site(
            username=current_user.user_name,
            project_id=project_id,
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except (
        SitesNotAvailableError,
        SitesUpstreamAuthenticationError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.post("/{project_id}/rename", response_model=SiteResponse)
async def rename_site(
    project_id: str,
    request: SiteRenameRequest,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Rename an owned Sites project."""
    try:
        return await sites_service.rename_site(
            username=current_user.user_name,
            project_id=project_id,
            title=request.title,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamAuthenticationError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)
```

- [ ] **Step 5: 运行 Backend 聚焦测试并确认 GREEN**

Run:

```bash
cd backend && uv run pytest tests/api/test_sites_api.py -q
```

Expected: PASS。

- [ ] **Step 6: 运行 Backend 格式和相关回归**

Run:

```bash
cd backend && uv run black --check app/core/config.py app/schemas/site.py app/services/sites.py app/api/endpoints/sites.py tests/api/test_sites_api.py
cd backend && uv run isort --check-only app/core/config.py app/schemas/site.py app/services/sites.py app/api/endpoints/sites.py tests/api/test_sites_api.py
cd backend && uv run pytest tests/api/test_sites_api.py tests/api/test_wework_auth_api.py -q
```

Expected: 全部 PASS，且 Wework 网关认证回归没有变化。

- [ ] **Step 7: 提交 Backend 变更接口**

```bash
git add backend/app/services/sites.py backend/app/api/endpoints/sites.py backend/tests/api/test_sites_api.py
git commit -m "feat(backend): proxy Sites project mutations"
```

## Task 3: Wework Sites API 客户端契约

**Files:**
- Modify: `wework/src/api/sites.test.ts:1-100`
- Modify: `wework/src/api/sites.ts:1-86`

- [ ] **Step 1: 将 API 测试改成新模型和 cursor，并先加入 rename 断言**

将 `wework/src/api/sites.test.ts` 的响应 fixture 和断言改为：

```typescript
const project = {
  id: 'prj/site-1',
  network: 'inner' as const,
  title: '产品站点',
  url: 'https://product.inner.example.test',
  snapshot: 'https://cdn.example.test/product.png',
  created_at: '2026-07-16T09:10:03.865Z',
}

test('lists projects with search and cursor through Wegent Backend', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ items: [project], next_cursor: 'prj-next' }),
  })

  const api = createSitesApi('/api')
  await api.listSites({ q: '产品 站点', cursor: 'prj/current', limit: 20 })

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/v1/sites?q=%E4%BA%A7%E5%93%81+%E7%AB%99%E7%82%B9&cursor=prj%2Fcurrent&limit=20',
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
    })
  )
})

test('omits empty search and cursor for the first page', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ items: [], next_cursor: null }),
  })

  const api = createSitesApi('http://127.0.0.1:9100/api', {
    getToken: () => 'cloud-secret',
    redirectOnUnauthorized: false,
  })
  await api.listSites({ q: '  ', cursor: null, limit: 20 })

  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:9100/api/v1/sites?limit=20',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer cloud-secret' }),
    })
  )
})

test('publishes a project using its encoded opaque id', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ ...project, network: 'outer' }),
  })

  const site = await createSitesApi('/api/').publishSite('prj/site-1')

  expect(site.network).toBe('outer')
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/sites/prj%2Fsite-1/publish', {
    method: 'POST',
    body: undefined,
    headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
  })
})

test('renames a project with a title body', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ ...project, title: '新名称' }),
  })

  await createSitesApi('/api/').renameSite('prj/site-1', '新名称')

  expect(fetchMock).toHaveBeenCalledWith('/api/v1/sites/prj%2Fsite-1/rename', {
    method: 'POST',
    body: JSON.stringify({ title: '新名称' }),
    headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
  })
})

test('deletes a project using its encoded opaque id', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 204 })

  await createSitesApi('/api/').deleteSite('prj/site-1')

  expect(fetchMock).toHaveBeenCalledWith('/api/v1/sites/prj%2Fsite-1', {
    method: 'DELETE',
    headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
  })
})
```

保留现有 `beforeEach`、`afterEach` 和 Token 初始化代码。

- [ ] **Step 2: 运行 API 测试并确认 RED**

Run:

```bash
pnpm --filter wework exec vitest run src/api/sites.test.ts
```

Expected: FAIL，原因是仍发送 offset、旧类型不存在 rename 方法。

- [ ] **Step 3: 实现新 TypeScript 客户端契约**

将 `wework/src/api/sites.ts` 的类型和 `createSitesApi` 返回对象改为：

```typescript
export type SiteNetwork = 'inner' | 'outer'

export interface SiteProject {
  id: string
  network: SiteNetwork
  title: string
  url: string
  snapshot: string
  created_at: string
}

export interface SiteListResponse {
  items: SiteProject[]
  next_cursor: string | null
}

export interface ListSitesInput {
  q?: string
  cursor?: string | null
  limit: number
}

export interface SitesApi {
  listSites(input: ListSitesInput): Promise<SiteListResponse>
  publishSite(projectId: string): Promise<SiteProject>
  renameSite(projectId: string, title: string): Promise<SiteProject>
  deleteSite(projectId: string): Promise<void>
}

export function createSitesApi(baseUrl: string, options: SitesApiOptions = {}): SitesApi {
  const client = createHttpClient({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    getToken: options.getToken,
    redirectOnUnauthorized: options.redirectOnUnauthorized,
  })

  return {
    listSites(input) {
      const params = new URLSearchParams()
      const query = input.q?.trim()
      if (query) params.set('q', query)
      if (input.cursor) params.set('cursor', input.cursor)
      params.set('limit', String(input.limit))
      return client.get(`/v1/sites?${params.toString()}`)
    },
    publishSite(projectId) {
      return client.post(`/v1/sites/${encodeURIComponent(projectId)}/publish`)
    },
    renameSite(projectId, title) {
      return client.post(`/v1/sites/${encodeURIComponent(projectId)}/rename`, { title })
    },
    deleteSite(projectId) {
      return client.delete<void>(`/v1/sites/${encodeURIComponent(projectId)}`)
    },
  }
}
```

`createUnavailableSitesApi` 的返回值增加：

```typescript
renameSite: unavailable,
```

删除旧 `SitePublishStatus` 和 `Site` 类型，不保留兼容别名。

- [ ] **Step 4: 运行 API 测试和类型检查并确认 GREEN**

Run:

```bash
pnpm --filter wework exec vitest run src/api/sites.test.ts
```

Expected: API 测试 PASS。完整 typecheck 在 Task 5 完成所有调用方迁移后运行。

- [ ] **Step 5: 提交 Wework API 契约**

如果 typecheck 仅有预期的 Sites 组件迁移错误，暂不使用 `--no-verify`，先完成 Task 4 和
Task 5 后再提交这三个紧密相关的前端任务。不要单独提交一个无法通过 Husky 的中间态。

## Task 4: cursor 列表、网络状态和发布行为

**Files:**
- Modify: `wework/src/components/sites/SitesWorkspace.test.tsx:14-135`
- Modify: `wework/src/components/sites/SitesWorkspace.tsx:14-271,422-491`
- Modify: `wework/src/components/sites/SiteActionsMenu.tsx:1-32`
- Modify: `wework/src/components/sites/DeleteSiteDialog.tsx:3-67`

- [ ] **Step 1: 先把 fixture 和列表/发布测试迁移到新项目模型**

将测试 helper 定义为：

```typescript
const innerProject: SiteProject = {
  id: 'prj-site-1',
  network: 'inner',
  title: '产品发布页',
  url: 'https://product.inner.example.test',
  snapshot: 'https://cdn.example.test/product.png',
  created_at: '2026-07-16T09:10:03.865Z',
}

function createApi(items: SiteProject[] = [innerProject]): SitesApi {
  return {
    listSites: vi.fn().mockResolvedValue({ items, next_cursor: null }),
    publishSite: vi.fn().mockResolvedValue({
      ...innerProject,
      network: 'outer',
      url: 'https://product.outer.example.test',
    }),
    renameSite: vi.fn().mockResolvedValue(innerProject),
    deleteSite: vi.fn().mockResolvedValue(undefined),
  }
}
```

更新 import 为 `SiteProject, SitesApi`，并用以下行为替换旧 offset/发布测试：

```typescript
test('loads projects and opens the network-specific URL', async () => {
  const api = createApi()
  render(<SitesWorkspace api={api} onCreate={vi.fn()} />)

  expect(await screen.findByText('产品发布页')).toBeInTheDocument()
  expect(api.listSites).toHaveBeenCalledWith({ q: '', cursor: null, limit: 20 })

  await userEvent.click(screen.getByTestId('site-url-prj-site-1'))
  expect(openExternalUrl).toHaveBeenCalledWith(innerProject.url)
  expect(screen.getByTestId('site-url-prj-site-1')).toHaveAccessibleName(
    '打开内部站点 产品发布页'
  )
})

test('loads a cursor page, deduplicates projects, and keeps existing rows', async () => {
  const secondProject: SiteProject = {
    ...innerProject,
    id: 'prj-site-2',
    title: '机器人学习站',
    url: 'https://robot.inner.example.test',
  }
  const api = createApi()
  vi.mocked(api.listSites)
    .mockResolvedValueOnce({ items: [innerProject], next_cursor: 'prj-site-1' })
    .mockResolvedValueOnce({
      items: [innerProject, secondProject],
      next_cursor: null,
    })

  render(<SitesWorkspace api={api} onCreate={vi.fn()} pageSize={1} />)
  await screen.findByText('产品发布页')
  await userEvent.click(screen.getByTestId('sites-load-more-button'))

  expect(await screen.findByText('机器人学习站')).toBeInTheDocument()
  expect(screen.getAllByText('产品发布页')).toHaveLength(1)
  expect(api.listSites).toHaveBeenLastCalledWith({
    q: '',
    cursor: 'prj-site-1',
    limit: 1,
  })
  expect(screen.queryByTestId('sites-load-more-button')).not.toBeInTheDocument()
})

test('resets the cursor for a new search and preserves rows when loading more fails', async () => {
  const api = createApi()
  vi.mocked(api.listSites)
    .mockResolvedValueOnce({ items: [innerProject], next_cursor: 'prj-site-1' })
    .mockRejectedValueOnce(new Error('下一页加载失败'))
    .mockResolvedValueOnce({ items: [], next_cursor: null })

  render(<SitesWorkspace api={api} onCreate={vi.fn()} pageSize={1} />)
  await screen.findByText('产品发布页')
  await userEvent.click(screen.getByTestId('sites-load-more-button'))

  expect(await screen.findByRole('alert')).toHaveTextContent('下一页加载失败')
  expect(screen.getByTestId('site-row-prj-site-1')).toBeInTheDocument()

  fireEvent.change(screen.getByTestId('sites-search-input'), {
    target: { value: '机器人' },
  })
  await waitFor(() =>
    expect(api.listSites).toHaveBeenLastCalledWith({
      q: '机器人',
      cursor: null,
      limit: 1,
    })
  )
})

test('replaces an inner project with the returned outer project', async () => {
  const api = createApi()
  render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
  await screen.findByText('产品发布页')

  await userEvent.click(screen.getByTestId('site-publish-prj-site-1'))

  await waitFor(() => expect(api.publishSite).toHaveBeenCalledWith('prj-site-1'))
  expect(await screen.findByText('https://product.outer.example.test')).toBeInTheDocument()
  expect(screen.queryByTestId('site-publish-prj-site-1')).not.toBeInTheDocument()
  expect(screen.getByTestId('site-published-prj-site-1')).toHaveTextContent('已发布')
})

test('keeps the project and shows a retryable error when publish fails', async () => {
  const api = createApi()
  vi.mocked(api.publishSite).mockRejectedValueOnce(new Error('外网发布失败'))
  render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
  await screen.findByText('产品发布页')

  await userEvent.click(screen.getByTestId('site-publish-prj-site-1'))

  expect(await screen.findByRole('alert')).toHaveTextContent('外网发布失败')
  expect(screen.getByTestId('site-row-prj-site-1')).toBeInTheDocument()
  expect(screen.getByTestId('site-publish-prj-site-1')).toBeEnabled()
})
```

保留 unavailable、search 和 create 测试，但把 list 参数断言从 `offset: 0` 改为
`cursor: null`。现有删除测试中的 id、test id 和 API 参数从 `site-1` 改为
`prj-site-1`。

- [ ] **Step 2: 运行 Workspace 测试并确认 RED**

Run:

```bash
pnpm --filter wework exec vitest run src/components/sites/SitesWorkspace.test.tsx
```

Expected: FAIL，原因是组件仍读取旧字段和 total/offset。

- [ ] **Step 3: 将行组件改为真实项目字段和网络状态**

在 `SitesWorkspace.tsx` 改用 `SiteProject`。`SiteThumbnail` 读取 `site.snapshot`。
`SiteRowProps` 增加 `publishError: string | null`，删除旧发布状态推导，并使用如下行为：

```typescript
const isOuter = site.network === 'outer'
const isPublishing = publishing

<article
  data-testid={`site-row-${site.id}`}
  className="grid gap-4 border-b border-border py-4 md:grid-cols-[minmax(0,1fr)_minmax(240px,0.55fr)] md:items-center md:gap-8"
>
  <div className="flex min-w-0 items-center gap-4">
    <SiteThumbnail site={site} />
    <div className="min-w-0">
      <h2 className="truncate text-base font-medium leading-5 text-text-primary">
        {site.title}
      </h2>
      <button
        type="button"
        data-testid={`site-url-${site.id}`}
        aria-label={t(isOuter ? 'open_external' : 'open_internal', {
          name: site.title,
        })}
        onClick={() => openUrl(site.url)}
        className="mt-1 flex max-w-full items-center gap-1 text-left text-sm leading-5 text-text-secondary transition-colors hover:text-text-primary"
      >
        <span className="truncate">{site.url}</span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>
    </div>
  </div>

  <div className="flex min-w-0 items-center justify-between gap-4 pl-24 md:pl-0">
    <div className="min-w-0 flex-1" aria-live="polite">
      {publishError ? (
        <span className="flex items-center gap-1.5 text-sm text-danger" role="alert">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{publishError}</span>
        </span>
      ) : isOuter ? (
        <span
          data-testid={`site-published-${site.id}`}
          className="flex items-center gap-1.5 text-sm text-text-secondary"
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {t('published', '已发布')}
        </span>
      ) : (
        <span className="text-sm text-text-muted">—</span>
      )}
    </div>
    {!isOuter && (
      <button
        type="button"
        data-testid={`site-publish-${site.id}`}
        disabled={isPublishing || deleting}
        onClick={() => onPublish(site)}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface disabled:cursor-wait disabled:opacity-60"
      >
        {isPublishing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {isPublishing ? t('publishing', '发布中') : t('publish', '发布到外网')}
      </button>
    )}
    <SiteActionsMenu
      site={site}
      disabled={isPublishing || deleting}
      onDelete={onDelete}
    />
  </div>
</article>
```

Task 5 会在这个已通过测试的操作菜单上增加 `onRename`。

- [ ] **Step 4: 将 offset/total 状态改为 cursor 并保留失败前内容**

在 `SitesWorkspace` 中：

```typescript
const [sites, setSites] = useState<SiteProject[]>([])
const [nextCursor, setNextCursor] = useState<string | null>(null)
const [publishErrors, setPublishErrors] = useState<Record<string, string>>({})
```

首屏请求固定使用 `cursor: null`，成功时 `setNextCursor(response.next_cursor)`。普通加载失败
不清空已有 `sites`；只有 `sites_not_available` 才清空项目并进入 unavailable 状态。
渲染 loading spinner 的条件改为 `loading && sites.length === 0`。

加入去重 helper：

```typescript
function appendUniqueSites(current: SiteProject[], incoming: SiteProject[]): SiteProject[] {
  const seen = new Set(current.map(site => site.id))
  return [...current, ...incoming.filter(site => !seen.has(site.id))]
}
```

`loadMore` 在 `!nextCursor` 时直接返回，请求使用当前 cursor，成功后：

```typescript
setSites(current => appendUniqueSites(current, response.items))
setNextCursor(response.next_cursor)
```

发布实现改为局部 pending/error，不修改项目字段：

```typescript
const publish = async (site: SiteProject) => {
  if (deletingSiteId === site.id || site.network === 'outer') return
  setPublishingIds(current => new Set(current).add(site.id))
  setPublishErrors(current => {
    const next = { ...current }
    delete next[site.id]
    return next
  })
  try {
    const published = await api.publishSite(site.id)
    setSites(current => current.map(item => (item.id === site.id ? published : item)))
  } catch (error) {
    setPublishErrors(current => ({
      ...current,
      [site.id]: errorMessage(error, t('publish_failed', '发布失败')),
    }))
  } finally {
    setPublishingIds(current => {
      const next = new Set(current)
      next.delete(site.id)
      return next
    })
  }
}
```

列表 key、测试标识、pending set 和删除状态全部从 `siteid` 改为 `id`；加载更多条件改为
`nextCursor !== null`。

同时将 `SiteActionsMenu` 和 `DeleteSiteDialog` 的类型改为 `SiteProject`：菜单 trigger 和
删除项 test id 使用 `site.id`，删除说明使用 `site.title`。此时操作菜单仍只包含删除，
重命名项由 Task 5 在失败测试后加入。

- [ ] **Step 5: 运行 Workspace 测试并确认 GREEN**

Run:

```bash
pnpm --filter wework exec vitest run src/components/sites/SitesWorkspace.test.tsx
```

Expected: Task 4 新增的列表、cursor、网络状态和发布测试 PASS。

## Task 5: 重命名、删除适配与双语文案

**Files:**
- Modify: `wework/src/components/common/TextInputDialog.tsx:7-89`
- Modify: `wework/src/components/common/TextInputDialog.test.tsx:5-73`
- Modify: `wework/src/components/sites/SiteActionsMenu.tsx:1-32`
- Modify: `wework/src/components/sites/DeleteSiteDialog.tsx:3-67`
- Modify: `wework/src/components/sites/SitesWorkspace.tsx`
- Modify: `wework/src/components/sites/SitesWorkspace.test.tsx:137-190`
- Modify: `wework/src/i18n/locales/zh-CN/sites.json`
- Modify: `wework/src/i18n/locales/en/sites.json`

- [ ] **Step 1: 为共享文本对话框补充最大长度失败测试**

在 `TextInputDialog.test.tsx` 的第一个 render 传入 `maxLength={255}`，并添加：

```typescript
expect(screen.getByTestId('rename-project-input')).toHaveAttribute('maxlength', '255')
```

将测试 imports 增加 `waitFor` 和 `userEvent`，再加入 pending 行为测试：

```typescript
test('keeps a pending submission open and prevents duplicate actions', async () => {
  let finishSubmit: (() => void) | undefined
  const onSubmit = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finishSubmit = resolve
      })
  )
  const onClose = vi.fn()
  render(
    <TextInputDialog
      open
      title="重命名项目"
      label="项目名称"
      initialValue="hello"
      confirmLabel="保存"
      cancelLabel="取消"
      inputTestId="rename-project-input"
      confirmTestId="confirm-rename-project-button"
      onClose={onClose}
      onSubmit={onSubmit}
    />
  )

  await userEvent.click(screen.getByTestId('confirm-rename-project-button'))
  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('rename-project-input')).toBeDisabled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()

  finishSubmit?.()
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
})
```

- [ ] **Step 2: 为站点重命名加入成功、校验和失败重试测试**

向 `SitesWorkspace.test.tsx` 添加：

```typescript
test('renames a project from the actions menu using the server response', async () => {
  const api = createApi()
  vi.mocked(api.renameSite).mockResolvedValueOnce({
    ...innerProject,
    title: '新产品站点',
    url: 'https://renamed.inner.example.test',
  })
  render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
  await screen.findByText('产品发布页')

  await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
  await userEvent.click(screen.getByTestId('site-rename-menu-item-prj-site-1'))
  const input = screen.getByTestId('site-rename-input')
  expect(input).toHaveValue('产品发布页')
  expect(input).toHaveAttribute('maxlength', '255')
  await userEvent.clear(input)
  expect(screen.getByTestId('site-rename-confirm-button')).toBeDisabled()
  await userEvent.type(input, '  新产品站点  ')
  await userEvent.click(screen.getByTestId('site-rename-confirm-button'))

  await waitFor(() =>
    expect(api.renameSite).toHaveBeenCalledWith('prj-site-1', '新产品站点')
  )
  expect(await screen.findByText('新产品站点')).toBeInTheDocument()
  expect(screen.getByText('https://renamed.inner.example.test')).toBeInTheDocument()
  expect(screen.queryByTestId('site-rename-input')).not.toBeInTheDocument()
})

test('keeps the rename dialog and value when the service rejects the change', async () => {
  const api = createApi()
  vi.mocked(api.renameSite).mockRejectedValueOnce(new Error('名称已存在'))
  render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
  await screen.findByText('产品发布页')

  await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
  await userEvent.click(screen.getByTestId('site-rename-menu-item-prj-site-1'))
  const input = screen.getByTestId('site-rename-input')
  await userEvent.clear(input)
  await userEvent.type(input, '重复名称')
  await userEvent.click(screen.getByTestId('site-rename-confirm-button'))

  expect(await screen.findByText('名称已存在')).toBeInTheDocument()
  expect(screen.getByTestId('site-rename-input')).toHaveValue('重复名称')
  expect(screen.getByTestId('site-rename-input')).toBeInTheDocument()
})
```

将现有删除测试的 `site-1` 标识和 API 参数全部改为 `prj-site-1`，并保留失败后行和
对话框仍存在的断言。

- [ ] **Step 3: 运行对话框和 Workspace 测试并确认 RED**

Run:

```bash
pnpm --filter wework exec vitest run src/components/common/TextInputDialog.test.tsx src/components/sites/SitesWorkspace.test.tsx
```

Expected: FAIL，因为 `maxLength`、重命名菜单和 Workspace rename 状态尚未实现。

- [ ] **Step 4: 扩展并复用 TextInputDialog**

在 `TextInputDialogProps` 增加：

```typescript
maxLength?: number
```

在 `TextInputDialogContent` 解构 `maxLength`，把 Escape 调用改为
`useEscapeKey(onClose, !submitting)`，并传给 input：

```tsx
<input
  data-testid={inputTestId}
  value={value}
  maxLength={maxLength}
  disabled={submitting}
  autoFocus
  onFocus={event => event.currentTarget.select()}
  onChange={event => {
    setValue(event.target.value)
    setError(null)
  }}
  className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
/>
```

使用设计规范指定的蓝色 focus 状态，不得新增 teal literal。
close 与 cancel 按钮都增加 `disabled={submitting}`，确保请求期间不能关闭并丢失输入；
现有 confirm 按钮继续用 `submitting` 防止重复提交。

- [ ] **Step 5: 在操作菜单加入重命名并迁移新项目字段**

`SiteActionsMenu.tsx` 改用 `Pencil, Trash2` 和 `SiteProject`，props/菜单项为：

```typescript
interface SiteActionsMenuProps {
  site: SiteProject
  disabled: boolean
  onRename: (site: SiteProject) => void
  onDelete: (site: SiteProject) => void
}

items={[
  {
    label: t('rename_site', '重命名站点'),
    icon: Pencil,
    testId: `site-rename-menu-item-${site.id}`,
    disabled,
    onSelect: () => onRename(site),
  },
  {
    label: t('delete_site', '删除站点'),
    icon: Trash2,
    testId: `site-delete-menu-item-${site.id}`,
    danger: true,
    disabled,
    onSelect: () => onDelete(site),
  },
]}
```

ActionMenu trigger test id 改为 ``site-more-${site.id}``。

- [ ] **Step 6: 接入 Workspace rename 状态并完成删除字段迁移**

在 `SitesWorkspace` 增加：

```typescript
const [pendingRenameSite, setPendingRenameSite] = useState<SiteProject | null>(null)

const renameSite = async (title: string) => {
  if (!pendingRenameSite) return
  const renamed = await api.renameSite(pendingRenameSite.id, title)
  setSites(current =>
    current.map(item => (item.id === pendingRenameSite.id ? renamed : item))
  )
}
```

把 `openDeleteDialog`、`pendingDeleteSite`、删除过滤和 pending id 全部改成
`SiteProject`/`site.id`。在页面末尾、删除对话框之前渲染：

```tsx
<TextInputDialog
  open={pendingRenameSite !== null}
  title={t('rename_title', '重命名站点')}
  label={t('rename_label', '站点名称')}
  description={t('rename_description', '输入新的站点名称。')}
  initialValue={pendingRenameSite?.title ?? ''}
  maxLength={255}
  confirmLabel={t('confirm_rename', '保存')}
  cancelLabel={t('cancel', '取消')}
  inputTestId="site-rename-input"
  confirmTestId="site-rename-confirm-button"
  onClose={() => setPendingRenameSite(null)}
  onSubmit={renameSite}
/>
```

`DeleteSiteDialog` 的 prop 类型改为 `SiteProject`，文案参数从 `site.name` 改为
`site.title`。保持失败时不关闭对话框。

- [ ] **Step 7: 同步中英文文案并删除死字段文案**

两份 `sites.json` 保持相同 key。中文相关段落使用：

```json
{
  "external_column": "网络访问",
  "publish": "发布到外网",
  "publishing": "发布中",
  "published": "已发布",
  "publish_failed": "发布失败",
  "open_internal": "打开内部站点 {{name}}",
  "open_external": "打开外部站点 {{name}}",
  "rename_site": "重命名站点",
  "rename_title": "重命名站点",
  "rename_label": "站点名称",
  "rename_description": "输入新的站点名称。",
  "confirm_rename": "保存",
  "delete_site": "删除站点",
  "delete_title": "删除站点？",
  "delete_description": "将删除“{{name}}”的站点项目；存在关联资源时服务会拒绝删除。本操作不会删除本地目录。",
  "delete_failed": "站点删除失败"
}
```

英文对应文案使用：

```json
{
  "external_column": "Network access",
  "publish": "Publish to internet",
  "publishing": "Publishing",
  "published": "Published",
  "publish_failed": "Publish failed",
  "open_internal": "Open internal site {{name}}",
  "open_external": "Open external site {{name}}",
  "rename_site": "Rename site",
  "rename_title": "Rename site",
  "rename_label": "Site name",
  "rename_description": "Enter a new name for this site.",
  "confirm_rename": "Save",
  "delete_site": "Delete site",
  "delete_title": "Delete site?",
  "delete_description": "This deletes the site project. The service refuses deletion while associated resources remain. Local files are not deleted.",
  "delete_failed": "Failed to delete site"
}
```

保留文件中仍被使用的 title、subtitle、search、create、refresh、empty、unavailable、
plugin 和通用按钮 key；删除不再引用的 `internal_url`、`external_url`、
`retry_publish`。

- [ ] **Step 8: 运行前端聚焦测试和类型检查并确认 GREEN**

Run:

```bash
pnpm --filter wework exec vitest run src/api/sites.test.ts src/components/common/TextInputDialog.test.tsx src/components/sites/SitesWorkspace.test.tsx
pnpm --filter wework typecheck
```

Expected: 全部 PASS，无旧 `siteid/internal_url/external_url/publish_status/thumbnail_url` 类型
引用。

- [ ] **Step 9: 提交 Wework API 和 Sites UI**

```bash
git add wework/src/api/sites.ts wework/src/api/sites.test.ts wework/src/components/common/TextInputDialog.tsx wework/src/components/common/TextInputDialog.test.tsx wework/src/components/sites/SiteActionsMenu.tsx wework/src/components/sites/DeleteSiteDialog.tsx wework/src/components/sites/SitesWorkspace.tsx wework/src/components/sites/SitesWorkspace.test.tsx wework/src/i18n/locales/zh-CN/sites.json wework/src/i18n/locales/en/sites.json
git commit -m "feat(wework): migrate Sites projects and add rename"
```

## Task 6: App 集成、格式检查和真实桌面验证

**Files:**
- Modify: `wework/src/App.plugins.test.tsx:708-897`
- Verify: all files changed in Tasks 1-5

- [ ] **Step 1: 更新页面级 Sites fixtures 和请求断言**

在 `App.plugins.test.tsx` 的 Sites 响应中把旧对象替换为：

```typescript
{
  id: 'prj-site-cloud-1',
  network: 'inner',
  title: '云端站点',
  url: 'https://cloud.inner.example.test',
  snapshot: 'https://cdn.example.test/cloud.png',
  created_at: '2026-07-16T09:10:03.865Z',
}
```

常规模式 fixture 使用：

```typescript
{
  id: 'prj-site-1',
  network: 'inner',
  title: '产品发布页',
  url: 'https://product.inner.example.test',
  snapshot: 'https://cdn.example.test/product.png',
  created_at: '2026-07-16T09:10:03.865Z',
}
```

所有列表响应由 `total/offset/limit` 改为 `next_cursor: null`，请求断言改为：

```typescript
'http://127.0.0.1:9100/api/v1/sites?limit=20'
'/api/v1/sites?limit=20'
```

- [ ] **Step 2: 运行 App 集成测试并确认 GREEN**

Run:

```bash
pnpm --filter wework exec vitest run src/App.plugins.test.tsx
```

Expected: PASS，创建 Sites 插件工作流断言保持不变。

- [ ] **Step 3: 搜索并删除旧协议残留**

Run:

```bash
rg -n '127\.0\.0\.1:8765|/api/v1/sites|offset|siteid|internal_url|external_url|publish_status|thumbnail_url' backend/app/services/sites.py backend/app/api/endpoints/sites.py backend/app/schemas/site.py backend/tests/api/test_sites_api.py wework/src/api/sites.ts wework/src/api/sites.test.ts wework/src/components/sites wework/src/App.plugins.test.tsx .env.example backend/.env.example docker-compose.yml
```

Expected: 不出现 8765、上游 `/api/v1/sites` 或旧站点字段。`offset` 仅允许出现在与本功能
无关的测试上下文；Backend 对 Wework 的 `/api/v1/sites` 网关路径仍应存在。

- [ ] **Step 4: 运行格式、lint 和完整聚焦回归**

Run:

```bash
pnpm --filter wework exec prettier --check src/api/sites.ts src/api/sites.test.ts src/components/common/TextInputDialog.tsx src/components/common/TextInputDialog.test.tsx src/components/sites/SiteActionsMenu.tsx src/components/sites/DeleteSiteDialog.tsx src/components/sites/SitesWorkspace.tsx src/components/sites/SitesWorkspace.test.tsx src/i18n/locales/zh-CN/sites.json src/i18n/locales/en/sites.json src/App.plugins.test.tsx
pnpm --filter wework exec eslint src/api/sites.ts src/api/sites.test.ts src/components/common/TextInputDialog.tsx src/components/common/TextInputDialog.test.tsx src/components/sites/SiteActionsMenu.tsx src/components/sites/DeleteSiteDialog.tsx src/components/sites/SitesWorkspace.tsx src/components/sites/SitesWorkspace.test.tsx src/App.plugins.test.tsx
pnpm --filter wework lint:typography
pnpm --filter wework exec vitest run src/api/sites.test.ts src/components/common/TextInputDialog.test.tsx src/components/sites/SitesWorkspace.test.tsx src/App.plugins.test.tsx
pnpm --filter wework typecheck
cd backend && uv run pytest tests/api/test_sites_api.py -q
```

Expected: 全部 PASS，输出没有 warning、Token 或测试跳过。

- [ ] **Step 5: 准备不泄露 Token 的真实服务验证环境**

在未跟踪的 Backend `.env` 中配置测试地址，并通过安全的本地编辑方式加入用户新提供的
`SITES_API_TOKEN` 值：

```dotenv
SITES_API_BASE_URL=http://10.54.33.62:18080
```

有效 Token 只能存在于未跟踪环境文件，不得写入计划、命令行参数或日志。运行
`git status --short`，确认 `.env` 未进入变更列表。

- [ ] **Step 6: 编写并执行真实 Tauri QA 用例**

前置条件：Backend 使用上述未跟踪配置运行；Wework 隔离会话已连接测试用户；服务中
至少有一个可安全修改的 `inner` 项目和一个可安全删除的项目。

执行：

```bash
pnpm --filter wework ai:verify start
```

从 JSON 输出记录 session 路径到任务专用变量 `WEWORK_SITES_VERIFY_SESSION`，然后执行：

```bash
pnpm --filter wework ai:verify snapshot --session "$WEWORK_SITES_VERIFY_SESSION"
pnpm --filter wework ai:verify click --session "$WEWORK_SITES_VERIFY_SESSION" --selector '[data-testid="sites-button"]'
pnpm --filter wework ai:verify wait-for --session "$WEWORK_SITES_VERIFY_SESSION" --selector '[data-testid="sites-workspace"]'
pnpm --filter wework ai:verify fill --session "$WEWORK_SITES_VERIFY_SESSION" --selector '[data-testid="sites-search-input"]' --value '测试'
pnpm --filter wework ai:verify wait-for --session "$WEWORK_SITES_VERIFY_SESSION" --selector '[data-testid^="site-row-"]'
```

对 snapshot 返回的真实项目 id，使用精确 data-testid 完成以下 QA：

1. 打开更多菜单和重命名，确认输入预填、空值不可提交、成功后标题更新。
2. 对 `inner` 项目点击发布，确认 pending 状态后按钮消失、项目显示“已发布”、URL 更新。
3. 对安全测试项目打开删除确认，先取消一次，再确认删除并验证行消失。
4. 将 Backend 的 `SITES_API_TOKEN` 临时改为无效测试值并重启 Backend；刷新页面，确认
   显示可恢复错误且 Wegent 登录和侧边栏仍保留。恢复有效 Token 后刷新成功。
5. 用 capture 保存最终正常态截图：

```bash
pnpm --filter wework ai:verify capture --session "$WEWORK_SITES_VERIFY_SESSION" --output test-results/ai-verify/sites-project-api.png
pnpm --filter wework ai:verify stop --session "$WEWORK_SITES_VERIFY_SESSION"
```

Expected: 主路径、失败恢复和登录隔离均符合设计；无 console error；隔离会话最终停止。
若任何步骤失败，保留 `test-results/ai-verify/` 下日志和截图证据，修复后重跑完整用例，
不得降级为浏览器 mock 验证。

- [ ] **Step 7: 提交 App 集成测试更新**

```bash
git add wework/src/App.plugins.test.tsx
git commit -m "test(wework): cover Sites project gateway integration"
```

- [ ] **Step 8: 最终工作树和提交检查**

Run:

```bash
git status --short
git log -6 --oneline --decorate
```

Expected: 工作树干净；提交只包含设计、计划和本功能实现，不含 `.env`、Token、session
文件或验证日志。

## English Execution Summary

Execute the six tasks in order and preserve the RED-GREEN discipline at every test boundary.
The backend owns the upstream token and username injection; Wework never receives either the
platform token or a user-selectable upstream username. Do not retain legacy upstream fields or
an 8765 fallback. Cursor behavior, mutation retries, rename validation, upstream 401 isolation,
and real-Tauri verification are release requirements, not optional follow-up work.
