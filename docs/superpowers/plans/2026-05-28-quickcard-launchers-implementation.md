---
sidebar_position: 1
---

# QuickCard Launchers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build QuickCard launchers with a two-row QuickCard state and a minimal vertical quick-phrase state that fills the chat input without sending.

**Architecture:** Backend exposes a normalized `/users/quick-launch` response that combines system functions and user favorite agents. Team quick phrases are stored on Team spec, while system functions live in a separate `SystemConfig` key. Frontend replaces `QuickAccessCards` with a thin compatibility wrapper around focused QuickLaunch components.

**Tech Stack:** FastAPI, Pydantic, SQLAlchemy, Next.js 15, React 19, TypeScript, Tailwind, Jest/Testing Library, pytest.

---

## File Structure

- Create `backend/app/schemas/quick_launch.py`
  - Owns quick phrase validation and QuickLaunch request/response models.
- Modify `backend/app/schemas/team.py`
  - Adds `quick_phrases` to Team create/update/list/detail schemas.
- Modify `backend/app/schemas/kind.py`
  - Adds `quick_phrases` to `TeamSpec`.
- Modify `backend/app/services/adapters/team_kinds.py`
  - Persists and returns `quick_phrases` from Team spec.
- Modify `backend/app/api/endpoints/users.py`
  - Adds `GET /users/quick-launch`.
- Modify `backend/app/api/endpoints/admin/system_config.py`
  - Adds admin GET/PUT for `quick_launch_functions`.
- Modify `backend/app/schemas/admin.py`
  - Re-exports admin quick launch schemas or imports them where needed.
- Create `backend/tests/schemas/test_quick_launch.py`
  - Validates phrase normalization.
- Modify `backend/tests/services/adapters/test_team_kinds_display_name.py`
  - Adds Team quick phrase persistence coverage.
- Create `backend/tests/api/endpoints/test_user_quick_launch.py`
  - Tests merged user response.
- Create `backend/tests/api/endpoints/test_admin_quick_launch_functions.py`
  - Tests admin config endpoints.
- Modify `frontend/src/types/api.ts`
  - Adds quick launch types and `Team.quick_phrases`.
- Modify `frontend/src/apis/user.ts`
  - Adds `getQuickLaunch`.
- Modify `frontend/src/apis/admin.ts`
  - Adds admin quick launch config types and methods.
- Modify `frontend/src/apis/team.ts`
  - Adds `quick_phrases` to `CreateTeamRequest`.
- Create `frontend/src/features/tasks/components/chat/quick-launch/types.ts`
  - UI-facing launcher types.
- Create `frontend/src/features/tasks/components/chat/quick-launch/useQuickLaunchers.ts`
  - Loads `/users/quick-launch`, filters mode-compatible teams, and maps response data.
- Create `frontend/src/features/tasks/components/chat/quick-launch/QuickLauncherCards.tsx`
  - Renders system-function row and favorite-agent row.
- Create `frontend/src/features/tasks/components/chat/quick-launch/QuickPhraseList.tsx`
  - Renders minimal vertical phrase list and current launcher title return control.
- Create `frontend/src/features/tasks/components/chat/quick-launch/QuickLaunchPanel.tsx`
  - Owns the two states and preserves existing create-agent and more/favorite behavior.
- Modify `frontend/src/features/tasks/components/chat/QuickAccessCards.tsx`
  - Turns existing export into a compatibility wrapper around `QuickLaunchPanel`.
- Modify `frontend/src/features/tasks/components/chat/ChatArea.tsx`
  - Passes `chatState.setTaskInputMessage` into QuickCard.
- Create `frontend/src/features/settings/components/team-edit/QuickPhraseEditor.tsx`
  - Reusable editor for Team quick phrases.
- Modify `frontend/src/features/settings/components/TeamEditDialog.tsx`
  - Adds state, load, and save plumbing for Team quick phrases.
- Modify `frontend/src/features/settings/components/team-edit/SimpleTeamEditForm.tsx`
  - Displays `QuickPhraseEditor`.
- Modify `frontend/src/features/settings/components/team-edit/simple-team-edit-save.ts`
  - Adds quick phrases to simple Team request builder.
- Modify `frontend/src/features/admin/components/SystemConfigPanel.tsx`
  - Adds a simple admin form for system function launchers.
- Modify i18n files:
  - `frontend/src/i18n/locales/zh-CN/common.json`
  - `frontend/src/i18n/locales/en/common.json`
  - `frontend/src/i18n/locales/zh-CN/settings.json`
  - `frontend/src/i18n/locales/en/settings.json`
  - `frontend/src/i18n/locales/zh-CN/admin.json`
  - `frontend/src/i18n/locales/en/admin.json`
- Create/modify tests:
  - `frontend/src/__tests__/features/tasks/components/chat/QuickAccessCards.test.tsx`
  - `frontend/src/__tests__/features/settings/components/team-edit/QuickPhraseEditor.test.tsx`
  - `frontend/src/__tests__/features/admin/SystemConfigPanel.test.tsx`

## Task 1: Backend Quick Phrase Models And Team Persistence

**Files:**
- Create: `backend/app/schemas/quick_launch.py`
- Modify: `backend/app/schemas/team.py`
- Modify: `backend/app/schemas/kind.py`
- Modify: `backend/app/services/adapters/team_kinds.py`
- Create: `backend/tests/schemas/test_quick_launch.py`
- Modify: `backend/tests/services/adapters/test_team_kinds_display_name.py`

- [ ] **Step 1: Write quick phrase normalization tests**

Create `backend/tests/schemas/test_quick_launch.py`:

```python
import pytest
from pydantic import ValidationError

from app.schemas.quick_launch import normalize_quick_phrases, QuickLaunchFunctionConfig


def test_normalize_quick_phrases_trims_blanks_and_limits_count():
    phrases = normalize_quick_phrases(
        ["  帮我创建一个 xxx 的 PPT  ", "", "  ", "把这份大纲整理成 PPT"]
    )

    assert phrases == ["帮我创建一个 xxx 的 PPT", "把这份大纲整理成 PPT"]


def test_quick_launch_function_rejects_more_than_six_phrases():
    with pytest.raises(ValidationError):
        QuickLaunchFunctionConfig(
            id="create_ppt",
            title="创建 PPT",
            team_id=1,
            quick_phrases=[f"phrase {index}" for index in range(7)],
        )
```

- [ ] **Step 2: Run schema tests and confirm failure**

Run:

```bash
cd backend && uv run pytest tests/schemas/test_quick_launch.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.schemas.quick_launch'`.

- [ ] **Step 3: Add quick launch schemas**

Create `backend/app/schemas/quick_launch.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

MAX_QUICK_PHRASES = 6
MAX_QUICK_PHRASE_LENGTH = 120


def normalize_quick_phrases(value: list[str] | None) -> list[str]:
    if not value:
        return []

    phrases: list[str] = []
    for phrase in value:
        trimmed = phrase.strip()
        if trimmed:
            phrases.append(trimmed)
    return phrases


class QuickPhraseMixin(BaseModel):
    quick_phrases: list[str] = Field(default_factory=list)

    @field_validator("quick_phrases", mode="before")
    @classmethod
    def validate_quick_phrases(cls, value: object) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("quick_phrases must be a list")

        phrases = normalize_quick_phrases(value)
        if len(phrases) > MAX_QUICK_PHRASES:
            raise ValueError(f"quick_phrases supports at most {MAX_QUICK_PHRASES} items")
        for phrase in phrases:
            if len(phrase) > MAX_QUICK_PHRASE_LENGTH:
                raise ValueError(
                    f"quick phrase must be at most {MAX_QUICK_PHRASE_LENGTH} characters"
                )
        return phrases


class QuickLaunchFunctionConfig(QuickPhraseMixin):
    id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    description: Optional[str] = None
    icon: Optional[str] = None
    team_id: int
    enabled: bool = True
    order: int = 0


class QuickLaunchFunctionResponse(QuickLaunchFunctionConfig):
    type: Literal["system_function"] = "system_function"
    name: str


class QuickLaunchFavoriteAgent(QuickPhraseMixin):
    type: Literal["favorite_agent"] = "favorite_agent"
    id: int
    team_id: int
    name: str
    title: str
    description: Optional[str] = None
    icon: Optional[str] = None
    recommended_mode: Optional[Literal["chat", "code", "both"]] = "both"
    agent_type: Optional[str] = None


class QuickLaunchResponse(BaseModel):
    system_functions: list[QuickLaunchFunctionResponse] = Field(default_factory=list)
    favorite_agents: list[QuickLaunchFavoriteAgent] = Field(default_factory=list)


class QuickLaunchFunctionsUpdate(BaseModel):
    functions: list[QuickLaunchFunctionConfig] = Field(default_factory=list)


class QuickLaunchFunctionsResponse(QuickLaunchFunctionsUpdate):
    version: int
```

- [ ] **Step 4: Run schema tests and confirm pass**

Run:

```bash
cd backend && uv run pytest tests/schemas/test_quick_launch.py -v
```

Expected: PASS.

- [ ] **Step 5: Write Team persistence test**

Append this test to `backend/tests/services/adapters/test_team_kinds_display_name.py`:

```python
def test_update_team_persists_quick_phrases_in_spec(test_db, test_user):
    team = _create_team_kind(test_db, test_user.id)

    result = team_kinds_service.update_with_user(
        test_db,
        team_id=team.id,
        obj_in=TeamUpdate(
            quick_phrases=["  帮我创建一个 xxx 的 PPT  ", "", "把这份大纲整理成 PPT"]
        ),
        user_id=test_user.id,
    )

    test_db.refresh(team)
    assert result["quick_phrases"] == ["帮我创建一个 xxx 的 PPT", "把这份大纲整理成 PPT"]
    assert team.json["spec"]["quick_phrases"] == [
        "帮我创建一个 xxx 的 PPT",
        "把这份大纲整理成 PPT",
    ]
```

- [ ] **Step 6: Run Team persistence test and confirm failure**

Run:

```bash
cd backend && uv run pytest tests/services/adapters/test_team_kinds_display_name.py::test_update_team_persists_quick_phrases_in_spec -v
```

Expected: FAIL with `quick_phrases` not accepted by `TeamUpdate` or missing from result.

- [ ] **Step 7: Add quick phrases to Team schemas**

Modify `backend/app/schemas/team.py`.

Import the mixin:

```python
from app.schemas.quick_launch import QuickPhraseMixin
```

Change these class declarations:

```python
class TeamBase(QuickPhraseMixin):
    """Team base model"""
```

```python
class TeamUpdate(QuickPhraseMixin):
    """Team update model"""
```

For update semantics, make `quick_phrases` optional after class attributes:

```python
    quick_phrases: Optional[List[str]] = None
```

Add `quick_phrases` to `TeamDetail`:

```python
    quick_phrases: List[str] = []
```

Modify `backend/app/schemas/kind.py` by importing the mixin:

```python
from app.schemas.quick_launch import QuickPhraseMixin
```

Change `TeamSpec`:

```python
class TeamSpec(QuickPhraseMixin):
    """Team specification"""
```

- [ ] **Step 8: Persist quick phrases in TeamKindsService**

Modify `backend/app/services/adapters/team_kinds.py`.

Import the normalizer:

```python
from app.schemas.quick_launch import normalize_quick_phrases
```

In `create_with_user`, after the `requires_workspace` block, add:

```python
        quick_phrases = getattr(obj_in, "quick_phrases", None)
        if quick_phrases is not None:
            spec["quick_phrases"] = normalize_quick_phrases(quick_phrases)
```

In `update_with_user`, after the `requires_workspace` update block, add:

```python
        if "quick_phrases" in update_data:
            team_crd.spec.quick_phrases = normalize_quick_phrases(
                update_data["quick_phrases"]
            )
```

In the dict returned by the Team conversion helpers, add:

```python
            "quick_phrases": normalize_quick_phrases(
                getattr(team_crd.spec, "quick_phrases", None)
            ),
```

Apply that return field in both conversion paths that currently return `icon` and `requires_workspace`.

- [ ] **Step 9: Run Team tests**

Run:

```bash
cd backend && uv run pytest tests/services/adapters/test_team_kinds_display_name.py -v
```

Expected: PASS.

- [ ] **Step 10: Commit backend Team persistence**

```bash
git add backend/app/schemas/quick_launch.py backend/app/schemas/team.py backend/app/schemas/kind.py backend/app/services/adapters/team_kinds.py backend/tests/schemas/test_quick_launch.py backend/tests/services/adapters/test_team_kinds_display_name.py
git commit -m "feat(backend): persist team quick phrases"
```

## Task 2: Backend Quick Launch User And Admin APIs

**Files:**
- Modify: `backend/app/api/endpoints/users.py`
- Modify: `backend/app/api/endpoints/admin/system_config.py`
- Modify: `backend/app/schemas/admin.py`
- Create: `backend/tests/api/endpoints/test_user_quick_launch.py`
- Create: `backend/tests/api/endpoints/test_admin_quick_launch_functions.py`

- [ ] **Step 1: Write user quick launch endpoint tests**

Create `backend/tests/api/endpoints/test_user_quick_launch.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace

import pytest

from app.api.endpoints import users as users_endpoint


class _FakeQuery:
    def __init__(self, results):
        self._results = results
        self._index = 0

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        if self._index >= len(self._results):
            return None
        result = self._results[self._index]
        self._index += 1
        return result


class _FakeDb:
    def __init__(self, configs):
        self._configs = configs

    def query(self, _model):
        return _FakeQuery(self._configs)


@pytest.mark.asyncio
async def test_quick_launch_returns_system_functions_and_favorite_agents(monkeypatch):
    quick_access_config = SimpleNamespace(version=2, config_value={"teams": [202]})
    function_config = SimpleNamespace(
        version=1,
        config_value={
            "functions": [
                {
                    "id": "create_ppt",
                    "title": "创建 PPT",
                    "team_id": 101,
                    "quick_phrases": ["帮我创建一个 xxx 的 PPT"],
                    "enabled": True,
                    "order": 10,
                }
            ]
        },
    )
    db = _FakeDb([quick_access_config, function_config])
    current_user = SimpleNamespace(
        id=7,
        preferences=json.dumps({"quick_access": {"version": 2, "teams": [202]}}),
    )

    def fake_get_team_by_id(team_id: int):
        return {
            "id": team_id,
            "metadata": {"name": f"team-{team_id}", "displayName": f"Team {team_id}"},
            "spec": {
                "description": f"Description {team_id}",
                "icon": "sparkles",
                "quick_phrases": [f"agent phrase {team_id}"],
                "bind_mode": ["chat"],
            },
            "agent_type": "claude",
        }

    monkeypatch.setattr(users_endpoint.kind_service, "get_team_by_id", fake_get_team_by_id)

    response = await users_endpoint.get_user_quick_launch(db=db, current_user=current_user)

    assert response.system_functions[0].id == "create_ppt"
    assert response.system_functions[0].team_id == 101
    assert response.system_functions[0].name == "team-101"
    assert response.system_functions[0].quick_phrases == ["帮我创建一个 xxx 的 PPT"]
    assert response.favorite_agents[0].team_id == 202
    assert response.favorite_agents[0].title == "Team 202"
    assert response.favorite_agents[0].quick_phrases == ["agent phrase 202"]
```

- [ ] **Step 2: Run user quick launch tests and confirm failure**

Run:

```bash
cd backend && uv run pytest tests/api/endpoints/test_user_quick_launch.py -v
```

Expected: FAIL with `AttributeError: module 'app.api.endpoints.users' has no attribute 'get_user_quick_launch'`.

- [ ] **Step 3: Implement user quick launch endpoint**

Modify `backend/app/api/endpoints/users.py`.

Add imports:

```python
from app.schemas.quick_launch import (
    QuickLaunchFavoriteAgent,
    QuickLaunchFunctionConfig,
    QuickLaunchFunctionResponse,
    QuickLaunchResponse,
    normalize_quick_phrases,
)
```

Add config key near `QUICK_ACCESS_CONFIG_KEY`:

```python
QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY = "quick_launch_functions"
```

Add helpers:

```python
def _get_system_config_value(db: Session, key: str) -> tuple[int, dict]:
    config = db.query(SystemConfig).filter(SystemConfig.config_key == key).first()
    if not config:
        return 0, {}
    return config.version, config.config_value or {}


def _get_user_quick_access_team_ids(current_user: User) -> list[int]:
    preferences = {}
    if current_user.preferences:
        try:
            preferences = json.loads(current_user.preferences)
        except (json.JSONDecodeError, TypeError):
            preferences = {}
    quick_access_config = preferences.get("quick_access", {})
    return quick_access_config.get("teams", [])


def _build_favorite_agent(team_id: int) -> Optional[QuickLaunchFavoriteAgent]:
    team_data = kind_service.get_team_by_id(team_id)
    if not team_data:
        return None
    metadata = team_data.get("metadata", {})
    spec = team_data.get("spec", {})
    title = metadata.get("displayName") or metadata.get("name", f"Team {team_id}")
    return QuickLaunchFavoriteAgent(
        id=team_data.get("id", team_id),
        team_id=team_data.get("id", team_id),
        name=metadata.get("name", f"team-{team_id}"),
        title=title,
        description=spec.get("description"),
        icon=spec.get("icon"),
        recommended_mode=spec.get("recommended_mode", "both"),
        agent_type=team_data.get("agent_type"),
        quick_phrases=normalize_quick_phrases(spec.get("quick_phrases")),
    )


def _build_system_function(
    config: QuickLaunchFunctionConfig,
) -> Optional[QuickLaunchFunctionResponse]:
    if not config.enabled:
        return None
    team_data = kind_service.get_team_by_id(config.team_id)
    if not team_data:
        return None
    metadata = team_data.get("metadata", {})
    return QuickLaunchFunctionResponse(
        **config.model_dump(),
        name=metadata.get("name", f"team-{config.team_id}"),
    )
```

Add endpoint:

```python
@router.get("/quick-launch", response_model=QuickLaunchResponse)
async def get_user_quick_launch(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get homepage launchers split into system functions and user favorite agents.
    """
    _, function_config = _get_system_config_value(db, QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY)
    raw_functions = function_config.get("functions", [])
    function_configs = [
        QuickLaunchFunctionConfig(**item)
        for item in raw_functions
        if isinstance(item, dict)
    ]
    system_functions = [
        function
        for function in (
            _build_system_function(config)
            for config in sorted(function_configs, key=lambda item: item.order)
        )
        if function is not None
    ]

    favorite_agents = [
        agent
        for agent in (_build_favorite_agent(team_id) for team_id in _get_user_quick_access_team_ids(current_user))
        if agent is not None
    ]

    return QuickLaunchResponse(
        system_functions=system_functions,
        favorite_agents=favorite_agents,
    )
```

If the line building `favorite_agents` exceeds 88 characters, split the generator into a named list before formatting.

- [ ] **Step 4: Run user quick launch tests**

Run:

```bash
cd backend && uv run pytest tests/api/endpoints/test_user_quick_launch.py -v
```

Expected: PASS.

- [ ] **Step 5: Write admin quick launch config tests**

Create `backend/tests/api/endpoints/test_admin_quick_launch_functions.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from app.api.endpoints.admin import system_config as system_config_endpoint
from app.schemas.quick_launch import QuickLaunchFunctionsUpdate


class _FakeQuery:
    def __init__(self, result):
        self._result = result

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._result


class _FakeDb:
    def __init__(self, config=None):
        self.config = config
        self.added = None
        self.committed = False

    def query(self, _model):
        return _FakeQuery(self.config)

    def add(self, value):
        self.added = value
        self.config = value

    def commit(self):
        self.committed = True

    def refresh(self, value):
        value.id = getattr(value, "id", 1)


@pytest.mark.asyncio
async def test_get_quick_launch_functions_returns_empty_default():
    response = await system_config_endpoint.get_quick_launch_functions_config(
        db=_FakeDb(),
        current_user=SimpleNamespace(id=1),
    )

    assert response.version == 0
    assert response.functions == []


@pytest.mark.asyncio
async def test_update_quick_launch_functions_normalizes_phrases():
    db = _FakeDb()

    response = await system_config_endpoint.update_quick_launch_functions_config(
        config_data=QuickLaunchFunctionsUpdate(
            functions=[
                {
                    "id": "create_ppt",
                    "title": "创建 PPT",
                    "team_id": 101,
                    "quick_phrases": ["  帮我创建一个 xxx 的 PPT  ", ""],
                    "enabled": True,
                    "order": 10,
                }
            ]
        ),
        db=db,
        current_user=SimpleNamespace(id=1),
    )

    assert db.committed is True
    assert response.version == 1
    assert response.functions[0].quick_phrases == ["帮我创建一个 xxx 的 PPT"]
```

- [ ] **Step 6: Run admin tests and confirm failure**

Run:

```bash
cd backend && uv run pytest tests/api/endpoints/test_admin_quick_launch_functions.py -v
```

Expected: FAIL with missing endpoint functions.

- [ ] **Step 7: Implement admin endpoints**

Modify `backend/app/api/endpoints/admin/system_config.py`.

Add imports:

```python
from app.schemas.quick_launch import (
    QuickLaunchFunctionsResponse,
    QuickLaunchFunctionsUpdate,
)
```

Add config key:

```python
QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY = "quick_launch_functions"
```

Add endpoints after the quick-access endpoints:

```python
@router.get(
    "/system-config/quick-launch-functions",
    response_model=QuickLaunchFunctionsResponse,
)
async def get_quick_launch_functions_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get system function launchers shown in the homepage QuickCard.
    """
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY)
        .first()
    )
    if not config:
        return QuickLaunchFunctionsResponse(version=0, functions=[])

    config_value = config.config_value or {}
    return QuickLaunchFunctionsResponse(
        version=config.version,
        functions=config_value.get("functions", []),
    )


@router.put(
    "/system-config/quick-launch-functions",
    response_model=QuickLaunchFunctionsResponse,
)
async def update_quick_launch_functions_config(
    config_data: QuickLaunchFunctionsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update system function launchers shown in the homepage QuickCard.
    """
    config_value = {
        "functions": [function.model_dump() for function in config_data.functions]
    }
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY)
        .first()
    )

    if not config:
        config = SystemConfig(
            config_key=QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY,
            config_value=config_value,
            version=1,
            updated_by=current_user.id,
        )
        db.add(config)
    else:
        config.config_value = config_value
        config.version = config.version + 1
        config.updated_by = current_user.id

    db.commit()
    db.refresh(config)

    return QuickLaunchFunctionsResponse(
        version=config.version,
        functions=config_value["functions"],
    )
```

- [ ] **Step 8: Run backend endpoint tests**

Run:

```bash
cd backend && uv run pytest tests/api/endpoints/test_user_quick_launch.py tests/api/endpoints/test_admin_quick_launch_functions.py -v
```

Expected: PASS.

- [ ] **Step 9: Run formatting for touched backend files**

Run:

```bash
cd backend && uv run black app/schemas/quick_launch.py app/schemas/team.py app/schemas/kind.py app/api/endpoints/users.py app/api/endpoints/admin/system_config.py tests/schemas/test_quick_launch.py tests/api/endpoints/test_user_quick_launch.py tests/api/endpoints/test_admin_quick_launch_functions.py tests/services/adapters/test_team_kinds_display_name.py
cd backend && uv run isort app/schemas/quick_launch.py app/schemas/team.py app/schemas/kind.py app/api/endpoints/users.py app/api/endpoints/admin/system_config.py tests/schemas/test_quick_launch.py tests/api/endpoints/test_user_quick_launch.py tests/api/endpoints/test_admin_quick_launch_functions.py tests/services/adapters/test_team_kinds_display_name.py
```

Expected: both commands complete with no errors.

- [ ] **Step 10: Commit backend quick launch APIs**

```bash
git add backend/app/api/endpoints/users.py backend/app/api/endpoints/admin/system_config.py backend/app/schemas/admin.py backend/tests/api/endpoints/test_user_quick_launch.py backend/tests/api/endpoints/test_admin_quick_launch_functions.py
git commit -m "feat(backend): add quick launch APIs"
```

## Task 3: Frontend Types, APIs, And QuickLaunch Components

**Files:**
- Modify: `frontend/src/types/api.ts`
- Modify: `frontend/src/apis/user.ts`
- Modify: `frontend/src/apis/admin.ts`
- Modify: `frontend/src/apis/team.ts`
- Create: `frontend/src/features/tasks/components/chat/quick-launch/types.ts`
- Create: `frontend/src/features/tasks/components/chat/quick-launch/useQuickLaunchers.ts`
- Create: `frontend/src/features/tasks/components/chat/quick-launch/QuickLauncherCards.tsx`
- Create: `frontend/src/features/tasks/components/chat/quick-launch/QuickPhraseList.tsx`
- Create: `frontend/src/features/tasks/components/chat/quick-launch/QuickLaunchPanel.tsx`

- [ ] **Step 1: Update TypeScript API types**

Modify `frontend/src/types/api.ts`:

```ts
export interface Team {
  id: number
  name: string
  displayName?: string | null
  namespace?: string
  description: string
  bots: TeamBot[]
  workflow: Record<string, string>
  is_active: boolean
  user_id: number
  created_at: string
  updated_at: string
  share_status?: number
  agent_type?: string
  is_mix_team?: boolean
  recommended_mode?: 'chat' | 'code' | 'both'
  bind_mode?: TaskType[]
  icon?: string
  quick_phrases?: string[]
  requires_workspace?: boolean
  default_for_modes?: string[]
  user?: {
    user_name: string
  }
}
```

Add after `QuickAccessResponse`:

```ts
export interface QuickLaunchFunction {
  type: 'system_function'
  id: string
  title: string
  description?: string | null
  icon?: string | null
  team_id: number
  name: string
  enabled: boolean
  order: number
  quick_phrases: string[]
}

export interface QuickLaunchFavoriteAgent {
  type: 'favorite_agent'
  id: number
  team_id: number
  name: string
  title: string
  description?: string | null
  icon?: string | null
  recommended_mode?: 'chat' | 'code' | 'both'
  agent_type?: string | null
  quick_phrases: string[]
}

export interface QuickLaunchResponse {
  system_functions: QuickLaunchFunction[]
  favorite_agents: QuickLaunchFavoriteAgent[]
}
```

Modify `frontend/src/apis/team.ts`:

```ts
export interface CreateTeamRequest {
  name: string
  displayName?: string | null
  description?: string
  bots?: TeamBot[]
  workflow?: Record<string, unknown>
  bind_mode?: TaskType[]
  is_active?: boolean
  namespace?: string
  icon?: string
  quick_phrases?: string[]
  requires_workspace?: boolean
}
```

- [ ] **Step 2: Add frontend API methods**

Modify imports in `frontend/src/apis/user.ts` to include `QuickLaunchResponse`, then add:

```ts
  async getQuickLaunch(): Promise<QuickLaunchResponse> {
    return apiClient.get('/users/quick-launch')
  },
```

Modify `frontend/src/apis/admin.ts` by adding types:

```ts
export interface QuickLaunchFunctionConfig {
  id: string
  title: string
  description?: string | null
  icon?: string | null
  team_id: number
  enabled: boolean
  order: number
  quick_phrases: string[]
}

export interface QuickLaunchFunctionsResponse {
  version: number
  functions: QuickLaunchFunctionConfig[]
}

export interface QuickLaunchFunctionsUpdate {
  functions: QuickLaunchFunctionConfig[]
}
```

Add methods near the existing quick access admin methods:

```ts
  async getQuickLaunchFunctionsConfig(): Promise<QuickLaunchFunctionsResponse> {
    return apiClient.get('/admin/system-config/quick-launch-functions')
  },

  async updateQuickLaunchFunctionsConfig(
    data: QuickLaunchFunctionsUpdate
  ): Promise<QuickLaunchFunctionsResponse> {
    return apiClient.put('/admin/system-config/quick-launch-functions', data)
  },
```

- [ ] **Step 3: Create UI-facing launcher types**

Create `frontend/src/features/tasks/components/chat/quick-launch/types.ts`:

```ts
import type { Team } from '@/types/api'

export type QuickLauncherKind = 'system_function' | 'favorite_agent'

export interface QuickLauncher {
  key: string
  type: QuickLauncherKind
  title: string
  description?: string | null
  icon?: string | null
  team: Team
  quickPhrases: string[]
}
```

- [ ] **Step 4: Create useQuickLaunchers hook**

Create `frontend/src/features/tasks/components/chat/quick-launch/useQuickLaunchers.ts`:

```ts
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { userApis } from '@/apis/user'
import type { QuickLaunchResponse, TaskType, Team } from '@/types/api'
import { filterTeamsByMode } from '../../selector/team-selector-utils'
import type { QuickLauncher } from './types'

interface UseQuickLaunchersOptions {
  teams: Team[]
  currentMode: TaskType
  defaultTeam?: Team | null
}

function findTeam(teams: Team[], teamId: number) {
  return teams.find(team => team.id === teamId) || null
}

export function useQuickLaunchers({ teams, currentMode, defaultTeam }: UseQuickLaunchersOptions) {
  const [data, setData] = useState<QuickLaunchResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const fetchQuickLaunch = useCallback(async () => {
    try {
      setIsLoading(true)
      setData(await userApis.getQuickLaunch())
    } catch (error) {
      console.error('Failed to fetch quick launch:', error)
      setData({ system_functions: [], favorite_agents: [] })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchQuickLaunch()
    window.addEventListener('quick-access-updated', fetchQuickLaunch)
    return () => window.removeEventListener('quick-access-updated', fetchQuickLaunch)
  }, [fetchQuickLaunch])

  const filteredTeams = useMemo(() => filterTeamsByMode(teams, currentMode), [teams, currentMode])

  const systemLaunchers = useMemo<QuickLauncher[]>(() => {
    return (data?.system_functions ?? [])
      .map(item => {
        const team = findTeam(filteredTeams, item.team_id)
        if (!team) return null
        return {
          key: `system:${item.id}`,
          type: 'system_function' as const,
          title: item.title,
          description: item.description,
          icon: item.icon,
          team,
          quickPhrases: item.quick_phrases ?? [],
        }
      })
      .filter((item): item is QuickLauncher => item !== null)
  }, [data?.system_functions, filteredTeams])

  const favoriteLaunchers = useMemo<QuickLauncher[]>(() => {
    return (data?.favorite_agents ?? [])
      .map(item => {
        const team = findTeam(filteredTeams, item.team_id)
        if (!team || defaultTeam?.id === team.id) return null
        return {
          key: `agent:${item.team_id}`,
          type: 'favorite_agent' as const,
          title: item.title,
          description: item.description,
          icon: item.icon,
          team,
          quickPhrases: item.quick_phrases ?? team.quick_phrases ?? [],
        }
      })
      .filter((item): item is QuickLauncher => item !== null)
  }, [data?.favorite_agents, defaultTeam?.id, filteredTeams])

  return {
    isLoading,
    refetch: fetchQuickLaunch,
    systemLaunchers,
    favoriteLaunchers,
  }
}
```

- [ ] **Step 5: Create QuickLauncherCards**

Create `frontend/src/features/tasks/components/chat/quick-launch/QuickLauncherCards.tsx`:

```tsx
'use client'

import type { QuickLauncher } from './types'

const CARD_WIDTH = 154

interface QuickLauncherCardsProps {
  systemLaunchers: QuickLauncher[]
  favoriteLaunchers: QuickLauncher[]
  onSelectLauncher: (launcher: QuickLauncher) => void
  renderMoreButton?: () => React.ReactNode
  renderQuickCreateCard?: () => React.ReactNode
}

function LauncherCard({
  launcher,
  accent,
  onClick,
}: {
  launcher: QuickLauncher
  accent: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`quick-launcher-${launcher.type}-${launcher.key.replace(':', '-')}`}
      onClick={onClick}
      className={`group relative flex flex-col justify-center text-left transition-all duration-200 ${
        accent
          ? 'border border-primary/25 bg-primary/5 hover:border-primary/50'
          : 'border border-border bg-base hover:bg-hover'
      } hover:shadow-sm`}
      style={{
        width: CARD_WIDTH,
        height: 78,
        padding: '8px 12px',
        borderRadius: 20,
        flexShrink: 0,
      }}
    >
      <span className={`block truncate text-[15px] font-semibold leading-5 ${accent ? 'text-primary' : 'text-text-primary'}`}>
        {launcher.title}
      </span>
      {launcher.description && (
        <span className="mt-1 block truncate text-xs leading-[18px] text-text-muted">
          {launcher.description}
        </span>
      )}
    </button>
  )
}

export function QuickLauncherCards({
  systemLaunchers,
  favoriteLaunchers,
  onSelectLauncher,
  renderMoreButton,
  renderQuickCreateCard,
}: QuickLauncherCardsProps) {
  return (
    <div className="w-full max-w-[820px] mx-auto mt-6 space-y-3" data-testid="quick-launch-cards">
      {systemLaunchers.length > 0 && (
        <section className="space-y-2" data-testid="quick-launch-system-row">
          <h3 className="px-1 text-xs font-medium text-text-muted">系统功能</h3>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {systemLaunchers.map(launcher => (
              <LauncherCard
                key={launcher.key}
                launcher={launcher}
                accent
                onClick={() => onSelectLauncher(launcher)}
              />
            ))}
          </div>
        </section>
      )}

      {(favoriteLaunchers.length > 0 || renderMoreButton || renderQuickCreateCard) && (
        <section className="space-y-2" data-testid="quick-launch-favorites-row">
          <h3 className="px-1 text-xs font-medium text-text-muted">收藏智能体</h3>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {favoriteLaunchers.map(launcher => (
              <LauncherCard
                key={launcher.key}
                launcher={launcher}
                accent={false}
                onClick={() => onSelectLauncher(launcher)}
              />
            ))}
            {renderMoreButton?.()}
            {renderQuickCreateCard?.()}
          </div>
        </section>
      )}
    </div>
  )
}
```

This uses visible Chinese row labels for now; Task 7 moves them into i18n.

- [ ] **Step 6: Create QuickPhraseList**

Create `frontend/src/features/tasks/components/chat/quick-launch/QuickPhraseList.tsx`:

```tsx
'use client'

import { ArrowLeft } from 'lucide-react'
import type { QuickLauncher } from './types'

interface QuickPhraseListProps {
  launcher: QuickLauncher
  onBack: () => void
  onPhraseSelect: (phrase: string) => void
}

export function QuickPhraseList({ launcher, onBack, onPhraseSelect }: QuickPhraseListProps) {
  return (
    <div className="w-full max-w-[620px] mx-auto mt-6" data-testid="quick-phrase-list">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 inline-flex min-h-[32px] items-center gap-1 rounded-md px-1 text-xs font-medium text-text-muted hover:text-text-primary"
        data-testid="quick-phrase-back"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {launcher.title}
      </button>

      {launcher.quickPhrases.length > 0 ? (
        <div className="flex flex-col gap-2">
          {launcher.quickPhrases.map((phrase, index) => (
            <button
              key={`${phrase}-${index}`}
              type="button"
              onClick={() => onPhraseSelect(phrase)}
              className="min-h-[44px] rounded-lg border border-border bg-base px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:border-primary/30 hover:bg-hover hover:text-text-primary"
              data-testid={`quick-phrase-${index}`}
            >
              {phrase}
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-base px-3 py-4 text-sm text-text-muted">
          暂无快捷短语
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Create QuickLaunchPanel skeleton**

Create `frontend/src/features/tasks/components/chat/quick-launch/QuickLaunchPanel.tsx` with loading and two-state behavior. Reuse more/create card rendering from `QuickAccessCards` in Task 4, so this initial file only owns state:

```tsx
'use client'

import { useState } from 'react'
import type { Team, TaskType } from '@/types/api'
import { useQuickLaunchers } from './useQuickLaunchers'
import { QuickLauncherCards } from './QuickLauncherCards'
import { QuickPhraseList } from './QuickPhraseList'
import type { QuickLauncher } from './types'

interface QuickLaunchPanelProps {
  teams: Team[]
  selectedTeam: Team | null
  onTeamSelect: (team: Team) => void
  onPhraseSelect: (phrase: string) => void
  currentMode: TaskType
  isLoading?: boolean
  defaultTeam?: Team | null
  renderMoreButton?: () => React.ReactNode
  renderQuickCreateCard?: () => React.ReactNode
}

export function QuickLaunchPanel({
  teams,
  onTeamSelect,
  onPhraseSelect,
  currentMode,
  isLoading,
  defaultTeam,
  renderMoreButton,
  renderQuickCreateCard,
}: QuickLaunchPanelProps) {
  const [selectedLauncher, setSelectedLauncher] = useState<QuickLauncher | null>(null)
  const { isLoading: isQuickLaunchLoading, systemLaunchers, favoriteLaunchers } =
    useQuickLaunchers({ teams, currentMode, defaultTeam })

  if (isLoading || isQuickLaunchLoading) {
    return <div className="mt-6 h-[108px] w-full animate-pulse rounded-lg bg-surface" />
  }

  if (selectedLauncher) {
    return (
      <QuickPhraseList
        launcher={selectedLauncher}
        onBack={() => setSelectedLauncher(null)}
        onPhraseSelect={phrase => {
          onTeamSelect(selectedLauncher.team)
          onPhraseSelect(phrase)
        }}
      />
    )
  }

  if (systemLaunchers.length === 0 && favoriteLaunchers.length === 0) {
    return null
  }

  return (
    <QuickLauncherCards
      systemLaunchers={systemLaunchers}
      favoriteLaunchers={favoriteLaunchers}
      onSelectLauncher={launcher => {
        onTeamSelect(launcher.team)
        setSelectedLauncher(launcher)
      }}
      renderMoreButton={renderMoreButton}
      renderQuickCreateCard={renderQuickCreateCard}
    />
  )
}
```

- [ ] **Step 8: Run frontend typecheck and confirm missing integration only**

Run:

```bash
cd frontend && npm run lint -- --file src/features/tasks/components/chat/quick-launch/QuickLaunchPanel.tsx
```

Expected: It may fail because project lint script does not support `--file`; if so run `cd frontend && npm run lint`. Any failures should be limited to newly added hard-coded labels, unused imports, or line wrapping.

- [ ] **Step 9: Commit frontend API and component skeleton**

```bash
git add frontend/src/types/api.ts frontend/src/apis/user.ts frontend/src/apis/admin.ts frontend/src/apis/team.ts frontend/src/features/tasks/components/chat/quick-launch
git commit -m "feat(frontend): add quick launch models"
```

## Task 4: Wire QuickLaunch Into ChatArea And Preserve Existing QuickAccess Behavior

**Files:**
- Modify: `frontend/src/features/tasks/components/chat/QuickAccessCards.tsx`
- Modify: `frontend/src/features/tasks/components/chat/ChatArea.tsx`
- Modify: `frontend/src/__tests__/features/tasks/components/chat/QuickAccessCards.test.tsx`

- [ ] **Step 1: Update QuickAccessCards tests for two states**

Modify `frontend/src/__tests__/features/tasks/components/chat/QuickAccessCards.test.tsx`.

Update the mock:

```ts
jest.mock('@/apis/user', () => ({
  userApis: {
    getQuickAccess: jest.fn(),
    getQuickLaunch: jest.fn(),
    getCurrentUser: jest.fn(),
    updateUser: jest.fn(),
  },
}))
```

Add helper:

```ts
const mockGetQuickLaunch = userApis.getQuickLaunch as jest.MockedFunction<
  typeof userApis.getQuickLaunch
>
```

In `beforeEach`, set default quick launch response:

```ts
mockGetQuickLaunch.mockResolvedValue({
  system_functions: [],
  favorite_agents: [],
})
```

Add test:

```tsx
test('renders system functions and favorite agents in separate rows', async () => {
  mockGetQuickLaunch.mockResolvedValueOnce({
    system_functions: [
      {
        type: 'system_function',
        id: 'create_ppt',
        title: 'Create PPT',
        team_id: 2,
        name: 'system-team',
        enabled: true,
        order: 10,
        quick_phrases: ['帮我创建一个 xxx 的 PPT'],
      },
    ],
    favorite_agents: [
      {
        type: 'favorite_agent',
        id: 3,
        team_id: 3,
        name: 'favorite-team',
        title: 'Favorite Team Display',
        quick_phrases: ['帮我生成周报'],
      },
    ],
  })

  renderQuickAccessCards(
    [
      makeTeam({ id: 2, name: 'system-team', description: 'System description' }),
      makeTeam({ id: 3, name: 'favorite-team', description: 'Favorite description' }),
    ],
    {
      system_version: 2,
      system_team_ids: [],
      user_version: 2,
      show_system_recommended: false,
      teams: [],
    }
  )

  expect(await screen.findByTestId('quick-launch-system-row')).toHaveTextContent('Create PPT')
  expect(screen.getByTestId('quick-launch-favorites-row')).toHaveTextContent(
    'Favorite Team Display'
  )
})
```

Add test:

```tsx
test('shows quick phrases after clicking a launcher and fills input without sending', async () => {
  const onPhraseSelect = jest.fn()
  const onTeamSelect = jest.fn()
  mockGetQuickLaunch.mockResolvedValueOnce({
    system_functions: [
      {
        type: 'system_function',
        id: 'create_ppt',
        title: 'Create PPT',
        team_id: 2,
        name: 'system-team',
        enabled: true,
        order: 10,
        quick_phrases: ['帮我创建一个 xxx 的 PPT', '把这份大纲整理成 PPT'],
      },
    ],
    favorite_agents: [],
  })

  render(
    <QuickAccessCards
      teams={[makeTeam({ id: 2, name: 'system-team', description: 'System description' })]}
      selectedTeam={null}
      onTeamSelect={onTeamSelect}
      onPhraseSelect={onPhraseSelect}
      currentMode="chat"
    />
  )

  fireEvent.click(await screen.findByText('Create PPT'))

  expect(screen.queryByTestId('quick-launch-cards')).not.toBeInTheDocument()
  expect(screen.getByTestId('quick-phrase-list')).toBeInTheDocument()
  expect(screen.getByTestId('quick-phrase-back')).toHaveTextContent('Create PPT')

  fireEvent.click(screen.getByText('帮我创建一个 xxx 的 PPT'))

  expect(onTeamSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }))
  expect(onPhraseSelect).toHaveBeenCalledWith('帮我创建一个 xxx 的 PPT')
})
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd frontend && npm test -- QuickAccessCards.test.tsx --runInBand
```

Expected: FAIL because `onPhraseSelect` is not a prop and `QuickAccessCards` still uses the old UI.

- [ ] **Step 3: Add onPhraseSelect prop and wrapper integration**

Modify `frontend/src/features/tasks/components/chat/QuickAccessCards.tsx`.

Import `QuickLaunchPanel`:

```ts
import { QuickLaunchPanel } from './quick-launch/QuickLaunchPanel'
```

Add prop:

```ts
  onPhraseSelect?: (phrase: string) => void
```

Destructure:

```ts
  onPhraseSelect,
```

Replace the final return block that renders the `quick-access-cards` div with:

```tsx
      <QuickLaunchPanel
        teams={teams}
        selectedTeam={selectedTeam}
        onTeamSelect={onTeamSelect}
        onPhraseSelect={onPhraseSelect ?? (() => undefined)}
        currentMode={currentMode}
        isLoading={isLoading || isQuickAccessLoading}
        defaultTeam={defaultTeam}
        renderMoreButton={renderMoreButton}
        renderQuickCreateCard={renderQuickCreateCard}
      />
```

Keep the existing `TeamEditDialog` block after the panel. Keep `renderMoreButton`, `renderQuickCreateCard`, popover logic, create-agent logic, and favorite update logic in the file for this iteration.

- [ ] **Step 4: Pass ChatInput setter from ChatArea**

Modify `frontend/src/features/tasks/components/chat/ChatArea.tsx` at the `QuickAccessCards` call:

```tsx
                <QuickAccessCards
                  teams={teams}
                  selectedTeam={chatState.selectedTeam}
                  onTeamSelect={handleTeamSelect}
                  onPhraseSelect={phrase => chatState.setTaskInputMessage(phrase)}
                  currentMode={taskType}
                  isLoading={isTeamsLoading}
                  isTeamsLoading={isTeamsLoading}
                  hideSelected={true}
                  onRefreshTeams={onRefreshTeams}
                  showWizardButton={taskType === 'chat'}
                  defaultTeam={chatState.defaultTeam}
                />
```

- [ ] **Step 5: Run QuickAccessCards tests**

Run:

```bash
cd frontend && npm test -- QuickAccessCards.test.tsx --runInBand
```

Expected: PASS after updating old assertions that expected `quick-access-cards` to `quick-launch-cards` where necessary.

- [ ] **Step 6: Commit QuickLaunch chat integration**

```bash
git add frontend/src/features/tasks/components/chat/QuickAccessCards.tsx frontend/src/features/tasks/components/chat/ChatArea.tsx frontend/src/__tests__/features/tasks/components/chat/QuickAccessCards.test.tsx
git commit -m "feat(frontend): add quickcard phrase state"
```

## Task 5: Team Quick Phrase Editor

**Files:**
- Create: `frontend/src/features/settings/components/team-edit/QuickPhraseEditor.tsx`
- Modify: `frontend/src/features/settings/components/team-edit/SimpleTeamEditForm.tsx`
- Modify: `frontend/src/features/settings/components/TeamEditDialog.tsx`
- Modify: `frontend/src/features/settings/components/team-edit/simple-team-edit-save.ts`
- Create: `frontend/src/__tests__/features/settings/components/team-edit/QuickPhraseEditor.test.tsx`

- [ ] **Step 1: Write QuickPhraseEditor tests**

Create `frontend/src/__tests__/features/settings/components/team-edit/QuickPhraseEditor.test.tsx`:

```tsx
import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import QuickPhraseEditor from '@/features/settings/components/team-edit/QuickPhraseEditor'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'settings:team.quick_phrases.add': 'Add phrase',
        'settings:team.quick_phrases.placeholder': 'Enter phrase',
        'common:actions.remove': 'Remove',
      }
      return translations[key] || key
    },
  }),
}))

describe('QuickPhraseEditor', () => {
  test('adds updates and removes phrases', () => {
    const onChange = jest.fn()
    render(<QuickPhraseEditor value={['first phrase']} onChange={onChange} />)

    fireEvent.change(screen.getByTestId('quick-phrase-input-0'), {
      target: { value: 'updated phrase' },
    })
    expect(onChange).toHaveBeenLastCalledWith(['updated phrase'])

    fireEvent.click(screen.getByTestId('add-quick-phrase'))
    expect(onChange).toHaveBeenLastCalledWith(['first phrase', ''])

    fireEvent.click(screen.getByTestId('remove-quick-phrase-0'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
```

- [ ] **Step 2: Run editor test and confirm failure**

Run:

```bash
cd frontend && npm test -- QuickPhraseEditor.test.tsx --runInBand
```

Expected: FAIL because `QuickPhraseEditor` does not exist.

- [ ] **Step 3: Implement QuickPhraseEditor**

Create `frontend/src/features/settings/components/team-edit/QuickPhraseEditor.tsx`:

```tsx
'use client'

import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'

const MAX_QUICK_PHRASES = 6
const MAX_QUICK_PHRASE_LENGTH = 120

interface QuickPhraseEditorProps {
  value: string[]
  onChange: (value: string[]) => void
}

export default function QuickPhraseEditor({ value, onChange }: QuickPhraseEditorProps) {
  const { t } = useTranslation()
  const phrases = value ?? []

  return (
    <div className="space-y-2">
      {phrases.map((phrase, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={phrase}
            maxLength={MAX_QUICK_PHRASE_LENGTH}
            onChange={event => {
              const next = [...phrases]
              next[index] = event.target.value
              onChange(next)
            }}
            placeholder={t('settings:team.quick_phrases.placeholder')}
            data-testid={`quick-phrase-input-${index}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(phrases.filter((_, itemIndex) => itemIndex !== index))}
            data-testid={`remove-quick-phrase-${index}`}
            aria-label={t('common:actions.remove')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}

      {phrases.length < MAX_QUICK_PHRASES && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...phrases, ''])}
          data-testid="add-quick-phrase"
        >
          <Plus className="mr-1 h-4 w-4" />
          {t('settings:team.quick_phrases.add')}
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run editor test**

Run:

```bash
cd frontend && npm test -- QuickPhraseEditor.test.tsx --runInBand
```

Expected: PASS.

- [ ] **Step 5: Wire editor state through TeamEditDialog**

Modify `frontend/src/features/settings/components/TeamEditDialog.tsx`.

Add state:

```ts
  const [quickPhrases, setQuickPhrases] = useState<string[]>([])
```

When loading `formTeam`, set:

```ts
      setQuickPhrases(formTeam.quick_phrases || [])
```

When clearing for new team, set:

```ts
      setQuickPhrases([])
```

Add `quickPhrases` to every `createTeam` and `updateTeam` payload:

```ts
              quick_phrases: quickPhrases.filter(phrase => phrase.trim()).map(phrase => phrase.trim()),
```

For the simple editor path, pass props to `SimpleTeamEditForm`:

```tsx
                quickPhrases={quickPhrases}
                onQuickPhrasesChange={setQuickPhrases}
```

- [ ] **Step 6: Add editor to SimpleTeamEditForm**

Modify `frontend/src/features/settings/components/team-edit/SimpleTeamEditForm.tsx`.

Import:

```ts
import QuickPhraseEditor from './QuickPhraseEditor'
```

Add props:

```ts
  quickPhrases: string[]
  onQuickPhrasesChange: (value: string[]) => void
```

Destructure them in the function props.

Add a row in the basic section after description:

```tsx
          <SimpleConfigRow
            label={t('settings:team.quick_phrases.label')}
            description={t('settings:team.quick_phrases.description')}
            align="start"
          >
            <QuickPhraseEditor value={quickPhrases} onChange={onQuickPhrasesChange} />
          </SimpleConfigRow>
```

- [ ] **Step 7: Update simple team request builder**

Modify `frontend/src/features/settings/components/team-edit/simple-team-edit-save.ts`.

Add to the form input type:

```ts
  quickPhrases: string[]
```

Add to the request object:

```ts
    quick_phrases: form.quickPhrases
      .map(phrase => phrase.trim())
      .filter(phrase => phrase.length > 0),
```

Update its call site in `TeamEditDialog.tsx` to pass `quickPhrases`.

- [ ] **Step 8: Run Team editor tests**

Run:

```bash
cd frontend && npm test -- QuickPhraseEditor.test.tsx --runInBand
```

Expected: PASS.

- [ ] **Step 9: Commit Team phrase editor**

```bash
git add frontend/src/features/settings/components/team-edit/QuickPhraseEditor.tsx frontend/src/features/settings/components/team-edit/SimpleTeamEditForm.tsx frontend/src/features/settings/components/TeamEditDialog.tsx frontend/src/features/settings/components/team-edit/simple-team-edit-save.ts frontend/src/__tests__/features/settings/components/team-edit/QuickPhraseEditor.test.tsx
git commit -m "feat(frontend): configure agent quick phrases"
```

## Task 6: Admin System Function Configuration UI

**Files:**
- Modify: `frontend/src/features/admin/components/SystemConfigPanel.tsx`
- Modify: `frontend/src/__tests__/features/admin/SystemConfigPanel.test.tsx`

- [ ] **Step 1: Write admin UI test**

Modify `frontend/src/__tests__/features/admin/SystemConfigPanel.test.tsx` to mock the new APIs and assert the section renders:

```tsx
expect(await screen.findByTestId('quick-launch-functions-section')).toBeInTheDocument()
expect(screen.getByText('Quick launch functions')).toBeInTheDocument()
```

Add default mocks:

```ts
adminApis.getQuickLaunchFunctionsConfig.mockResolvedValue({
  version: 0,
  functions: [],
})
adminApis.updateQuickLaunchFunctionsConfig.mockResolvedValue({
  version: 1,
  functions: [],
})
```

- [ ] **Step 2: Run admin UI test and confirm failure**

Run:

```bash
cd frontend && npm test -- SystemConfigPanel.test.tsx --runInBand
```

Expected: FAIL because the section and methods are missing.

- [ ] **Step 3: Add minimal function config state**

Modify `frontend/src/features/admin/components/SystemConfigPanel.tsx`.

Import types:

```ts
  QuickLaunchFunctionConfig,
  QuickLaunchFunctionsResponse,
```

Add state:

```ts
  const [quickLaunchFunctions, setQuickLaunchFunctions] = useState<QuickLaunchFunctionConfig[]>([])
  const [quickLaunchFunctionsVersion, setQuickLaunchFunctionsVersion] = useState(0)
```

Update `fetchConfig` Promise tuple to include `adminApis.getQuickLaunchFunctionsConfig()` and assign:

```ts
      setQuickLaunchFunctions(quickLaunchResponse.functions)
      setQuickLaunchFunctionsVersion(quickLaunchResponse.version)
```

Use a distinct variable name such as `quickLaunchFunctionsResponse` to avoid colliding with existing quick access response.

- [ ] **Step 4: Add minimal section render**

Add this card after the existing Quick Access card:

```tsx
      <Card className="p-6" data-testid="quick-launch-functions-section">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-md font-medium text-text-primary">
              {t('admin:system_config.quick_launch_functions_title')}
            </h3>
            <p className="text-sm text-text-muted mt-1">
              {t('admin:system_config.quick_launch_functions_description')}
            </p>
          </div>
          <span className="text-xs text-text-muted flex-shrink-0">
            {t('admin:system_config.quick_access_version')}: {quickLaunchFunctionsVersion}
          </span>
        </div>
        <Textarea
          value={JSON.stringify(quickLaunchFunctions, null, 2)}
          onChange={event => {
            try {
              const parsed = JSON.parse(event.target.value)
              if (Array.isArray(parsed)) {
                setQuickLaunchFunctions(parsed)
              }
            } catch {
              setQuickLaunchFunctions(quickLaunchFunctions)
            }
          }}
          className="min-h-[220px] font-mono text-xs"
          data-testid="quick-launch-functions-json"
        />
      </Card>
```

This intentionally uses JSON editing for the first implementation to avoid a large admin form. The backend validates the final shape on save.

- [ ] **Step 5: Save quick launch function config**

In `handleSave`, include:

```ts
        adminApis.updateQuickLaunchFunctionsConfig({
          functions: quickLaunchFunctions,
        }),
```

Update the Promise tuple and set:

```ts
      setQuickLaunchFunctionsVersion(quickLaunchFunctionsResponse.version)
      setQuickLaunchFunctions(quickLaunchFunctionsResponse.functions)
```

- [ ] **Step 6: Run admin UI test**

Run:

```bash
cd frontend && npm test -- SystemConfigPanel.test.tsx --runInBand
```

Expected: PASS after updating mock names and i18n strings.

- [ ] **Step 7: Commit admin function config UI**

```bash
git add frontend/src/features/admin/components/SystemConfigPanel.tsx frontend/src/__tests__/features/admin/SystemConfigPanel.test.tsx
git commit -m "feat(frontend): configure quick launch functions"
```

## Task 7: i18n And Polish

**Files:**
- Modify: `frontend/src/i18n/locales/zh-CN/common.json`
- Modify: `frontend/src/i18n/locales/en/common.json`
- Modify: `frontend/src/i18n/locales/zh-CN/settings.json`
- Modify: `frontend/src/i18n/locales/en/settings.json`
- Modify: `frontend/src/i18n/locales/zh-CN/admin.json`
- Modify: `frontend/src/i18n/locales/en/admin.json`
- Modify: `frontend/src/features/tasks/components/chat/quick-launch/QuickLauncherCards.tsx`
- Modify: `frontend/src/features/tasks/components/chat/quick-launch/QuickPhraseList.tsx`

- [ ] **Step 1: Add translation keys**

Add to `frontend/src/i18n/locales/zh-CN/common.json` under `teams`:

```json
"quick_launch_system_functions": "系统功能",
"quick_launch_favorite_agents": "收藏智能体",
"quick_launch_empty_phrases": "暂无快捷短语"
```

Add to `frontend/src/i18n/locales/en/common.json` under `teams`:

```json
"quick_launch_system_functions": "System functions",
"quick_launch_favorite_agents": "Favorite agents",
"quick_launch_empty_phrases": "No quick phrases yet"
```

Add to `frontend/src/i18n/locales/zh-CN/settings.json` under `team`:

```json
"quick_phrases": {
  "label": "快捷短语",
  "description": "点击 QuickCard 后展示，用户点击后会填入聊天输入框。",
  "add": "添加短语",
  "placeholder": "例如：帮我创建一个 xxx 的 PPT"
}
```

Add to `frontend/src/i18n/locales/en/settings.json` under `team`:

```json
"quick_phrases": {
  "label": "Quick phrases",
  "description": "Shown after clicking a QuickCard. Clicking a phrase fills the chat input.",
  "add": "Add phrase",
  "placeholder": "Example: Help me create a PPT about xxx"
}
```

Add to `frontend/src/i18n/locales/zh-CN/admin.json` under `system_config`:

```json
"quick_launch_functions_title": "系统功能入口",
"quick_launch_functions_description": "配置首页 QuickCard 第一行展示的系统功能、绑定智能体和快捷短语。"
```

Add to `frontend/src/i18n/locales/en/admin.json` under `system_config`:

```json
"quick_launch_functions_title": "Quick launch functions",
"quick_launch_functions_description": "Configure the system functions, bound agents, and quick phrases shown in the first QuickCard row."
```

- [ ] **Step 2: Replace hard-coded labels**

In `QuickLauncherCards.tsx`, import:

```ts
import { useTranslation } from '@/hooks/useTranslation'
```

Inside `QuickLauncherCards`, add:

```ts
  const { t } = useTranslation('common')
```

Replace labels:

```tsx
{t('teams.quick_launch_system_functions')}
{t('teams.quick_launch_favorite_agents')}
```

In `QuickPhraseList.tsx`, import and use:

```ts
import { useTranslation } from '@/hooks/useTranslation'
```

Inside component:

```ts
  const { t } = useTranslation('common')
```

Replace empty text:

```tsx
{t('teams.quick_launch_empty_phrases')}
```

- [ ] **Step 3: Run frontend tests**

Run:

```bash
cd frontend && npm test -- QuickAccessCards.test.tsx QuickPhraseEditor.test.tsx SystemConfigPanel.test.tsx --runInBand
```

Expected: PASS.

- [ ] **Step 4: Run frontend format and lint**

Run:

```bash
cd frontend && npm run format
cd frontend && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit i18n and polish**

```bash
git add frontend/src/i18n/locales/zh-CN/common.json frontend/src/i18n/locales/en/common.json frontend/src/i18n/locales/zh-CN/settings.json frontend/src/i18n/locales/en/settings.json frontend/src/i18n/locales/zh-CN/admin.json frontend/src/i18n/locales/en/admin.json frontend/src/features/tasks/components/chat/quick-launch/QuickLauncherCards.tsx frontend/src/features/tasks/components/chat/quick-launch/QuickPhraseList.tsx
git commit -m "chore(frontend): polish quick launch copy"
```

## Task 8: Final Verification

**Files:**
- No source files expected unless verification reveals a bug.

- [ ] **Step 1: Run backend targeted tests**

Run:

```bash
cd backend && uv run pytest tests/schemas/test_quick_launch.py tests/services/adapters/test_team_kinds_display_name.py tests/api/endpoints/test_user_quick_launch.py tests/api/endpoints/test_admin_quick_launch_functions.py tests/api/endpoints/test_user_quick_access.py -v
```

Expected: PASS.

- [ ] **Step 2: Run frontend targeted tests**

Run:

```bash
cd frontend && npm test -- QuickAccessCards.test.tsx QuickPhraseEditor.test.tsx SystemConfigPanel.test.tsx --runInBand
```

Expected: PASS.

- [ ] **Step 3: Run frontend lint**

Run:

```bash
cd frontend && npm run lint
```

Expected: PASS.

- [ ] **Step 4: Run backend formatting check**

Run:

```bash
cd backend && uv run black --check app tests
cd backend && uv run isort --check-only app tests
```

Expected: PASS.

- [ ] **Step 5: Manual smoke test in browser**

Run the app with the project’s normal local stack. If services are already running, reuse them. Otherwise:

```bash
docker compose up -d
```

Then open the frontend and verify:

- Empty chat shows two QuickCard rows.
- Clicking a system function hides both rows and shows vertical phrases.
- The return label uses the selected launcher name.
- Clicking a phrase fills the chat input.
- Clicking send sends through the existing input flow.
- Clicking return restores both QuickCard rows without clearing input text.

- [ ] **Step 6: Commit verification fixes if any**

If verification reveals a defect, edit the failing source or test file, rerun the command that failed, then commit only the changed files with this message:

```bash
git commit -m "fix: stabilize quick launch behavior"
```

If no fixes are needed, do not create an empty commit.

## Self-Review

- Spec coverage:
  - Two QuickCard rows: Task 3 and Task 4.
  - Two UI states only: Task 3 and Task 4.
  - Phrase click fills ChatInput and does not send: Task 4 tests and implementation.
  - System functions and favorites have separate data: Task 2 and Task 3.
  - Agent quick phrase configuration: Task 1 and Task 5.
  - Admin system function configuration: Task 2 and Task 6.
- Placeholder scan:
  - The plan contains no placeholder markers or intentionally deferred implementation slots.
- Type consistency:
  - Backend uses `quick_phrases`.
  - Frontend API types use `quick_phrases`.
  - UI-facing mapped type uses `quickPhrases`.
  - Launcher title is rendered from `launcher.title`.
