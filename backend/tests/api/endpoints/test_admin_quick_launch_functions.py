# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.schemas.quick_launch import QuickLaunchFunctionsUpdate

_SYSTEM_CONFIG_PATH = (
    Path(__file__).resolve().parents[3]
    / "app"
    / "api"
    / "endpoints"
    / "admin"
    / "system_config.py"
)
_SPEC = importlib.util.spec_from_file_location(
    "admin_system_config_endpoint",
    _SYSTEM_CONFIG_PATH,
)
system_config_endpoint = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(system_config_endpoint)


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
