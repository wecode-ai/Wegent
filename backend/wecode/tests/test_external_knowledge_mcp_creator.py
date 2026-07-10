# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal external knowledge MCP creator adapters."""

import json
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

import pytest

from app.mcp_server.server import (
    ensure_external_knowledge_tools_registered,
    external_knowledge_mcp_server,
)
from app.models.user import User
from wecode.mcp_server.creator_resolver import wecode_creator_resolver
from wecode.mcp_server.external_knowledge_tools import (
    wecode_wegent_kb_list_knowledge_bases,
)
from wecode.models.erp_user import WecodeErpUser
from wecode.service.erp_client import EmployeeInfo
from wecode.service.erp_user_identity import (
    resolve_active_user_id_by_employee_id,
    resolve_owner_user_ids_by_employee_ids,
)


def _add_user(test_db, user_name: str) -> User:
    user = User(user_name=user_name, password_hash="x", is_active=True)
    test_db.add(user)
    test_db.flush()
    return user


@contextmanager
def _session_context(test_db):
    yield test_db


def test_resolve_owner_user_ids_uses_cached_employee_profile(test_db):
    user = _add_user(test_db, "cached-owner")
    test_db.add(
        WecodeErpUser(
            user_id=user.id,
            employee_id="10001",
            erp_name="Cached Owner",
            email="cached-owner@example.com",
        )
    )
    test_db.commit()

    user_ids = resolve_owner_user_ids_by_employee_ids(test_db, ["10001"])

    assert user_ids == [user.id]


def test_resolve_owner_user_ids_uses_exact_erp_fallback(test_db):
    user = _add_user(test_db, "fallback-owner")

    with patch(
        "wecode.service.erp_user_identity.erp_client.search_employee",
        return_value=EmployeeInfo(
            ssn="10002",
            name="Fallback Owner",
            email="fallback-owner@example.com",
        ),
    ) as search_employee:
        user_ids = resolve_owner_user_ids_by_employee_ids(test_db, ["10002"])

    assert user_ids == [user.id]
    search_employee.assert_called_once_with("10002")


def test_resolve_owner_user_ids_keeps_cached_inactive_profile(test_db):
    user = _add_user(test_db, "inactive-owner")
    user.is_active = False
    test_db.add(
        WecodeErpUser(
            user_id=user.id,
            employee_id="10008",
            erp_name="Inactive Owner",
            email="inactive-owner@example.com",
        )
    )
    test_db.commit()

    with patch(
        "wecode.service.erp_user_identity.erp_client.search_employee"
    ) as search_employee:
        user_ids = resolve_owner_user_ids_by_employee_ids(test_db, ["10008"])

    assert user_ids == [user.id]
    search_employee.assert_not_called()


def test_resolve_active_user_id_falls_back_for_stale_cached_profile(test_db):
    stale_user = _add_user(test_db, "stale-owner")
    stale_user.is_active = False
    active_user = _add_user(test_db, "active-owner")
    test_db.add(
        WecodeErpUser(
            user_id=stale_user.id,
            employee_id="10008",
            erp_name="Stale Owner",
            email="stale-owner@example.com",
        )
    )
    test_db.commit()

    with patch(
        "wecode.service.erp_user_identity.erp_client.search_employee",
        return_value=EmployeeInfo(
            ssn="10008",
            name="Active Owner",
            email="active-owner@example.com",
        ),
    ) as search_employee:
        user_id = resolve_active_user_id_by_employee_id(test_db, "10008")

    assert user_id == active_user.id
    search_employee.assert_called_once_with("10008")


def test_resolve_active_user_id_rejects_inactive_erp_fallback(test_db):
    inactive_user = _add_user(test_db, "inactive-fallback")
    inactive_user.is_active = False
    test_db.commit()

    with patch(
        "wecode.service.erp_user_identity.erp_client.search_employee",
        return_value=EmployeeInfo(
            ssn="10009",
            name="Inactive Fallback",
            email="inactive-fallback@example.com",
        ),
    ):
        user_id = resolve_active_user_id_by_employee_id(test_db, "10009")

    assert user_id is None


def test_resolve_owner_user_ids_allows_inactive_erp_fallback(test_db):
    inactive_user = _add_user(test_db, "inactive-filter")
    inactive_user.is_active = False
    test_db.commit()

    with patch(
        "wecode.service.erp_user_identity.erp_client.search_employee",
        return_value=EmployeeInfo(
            ssn="10010",
            name="Inactive Filter",
            email="inactive-filter@example.com",
        ),
    ):
        user_ids = resolve_owner_user_ids_by_employee_ids(test_db, ["10010"])

    assert user_ids == [inactive_user.id]


def test_resolve_owner_user_ids_falls_back_when_cached_user_is_deleted(test_db):
    user = _add_user(test_db, "deleted-fallback")
    test_db.add(
        WecodeErpUser(
            user_id=999999,
            employee_id="10011",
            erp_name="Deleted Owner",
            email="deleted-owner@example.com",
        )
    )
    test_db.commit()

    with patch(
        "wecode.service.erp_user_identity.erp_client.search_employee",
        return_value=EmployeeInfo(
            ssn="10011",
            name="Deleted Fallback",
            email="deleted-fallback@example.com",
        ),
    ):
        user_ids = resolve_owner_user_ids_by_employee_ids(test_db, ["10011"])

    assert user_ids == [user.id]


def test_resolve_owner_user_ids_falls_back_for_all_accepted_uncached_ids(test_db):
    users = [_add_user(test_db, f"owner-{index}") for index in range(25)]
    employee_ids = [f"20{index:03d}" for index in range(25)]
    test_db.commit()

    def search_employee(employee_id: str) -> EmployeeInfo:
        index = employee_ids.index(employee_id)
        return EmployeeInfo(
            ssn=employee_id,
            name=f"Owner {index}",
            email=f"owner-{index}@example.com",
        )

    with patch(
        "wecode.service.erp_user_identity.erp_client.search_employee",
        side_effect=search_employee,
    ) as search_employee_mock:
        user_ids = resolve_owner_user_ids_by_employee_ids(test_db, employee_ids)

    assert user_ids == [user.id for user in users]
    assert search_employee_mock.call_count == len(employee_ids)


def test_resolve_owner_user_ids_rejects_non_exact_erp_result(test_db):
    _add_user(test_db, "someone-else")

    with patch(
        "wecode.service.erp_user_identity.erp_client.search_employee",
        return_value=EmployeeInfo(
            ssn="10003",
            name="someone-else",
            email="other@example.com",
        ),
    ):
        user_ids = resolve_owner_user_ids_by_employee_ids(test_db, ["10004"])

    assert user_ids == []


def test_resolve_owner_user_ids_degrades_when_erp_unavailable(test_db):
    with patch(
        "wecode.service.erp_user_identity.erp_client.search_employee",
        side_effect=RuntimeError("unavailable"),
    ):
        user_ids = resolve_owner_user_ids_by_employee_ids(test_db, ["10005"])

    assert user_ids == []


def test_wecode_creator_resolver_enriches_cached_attributes(test_db):
    user = _add_user(test_db, "creator-cache")
    test_db.add(
        WecodeErpUser(
            user_id=user.id,
            employee_id="10006",
            erp_name="Creator Cache",
            email="creator-cache@example.com",
        )
    )
    test_db.commit()

    creator_map = wecode_creator_resolver(test_db, [user.id])

    assert creator_map[user.id].user_id == user.id
    assert creator_map[user.id].user_name == "creator-cache"
    assert creator_map[user.id].attributes == {
        "employee_id": "10006",
        "email_prefix": "creator-cache",
        "name": "Creator Cache",
    }


def test_wecode_creator_resolver_degrades_when_erp_unavailable(test_db):
    user = _add_user(test_db, "creator-missing")
    test_db.commit()

    with patch(
        "wecode.mcp_server.creator_resolver.erp_client.search_employee",
        side_effect=RuntimeError("unavailable"),
    ):
        creator_map = wecode_creator_resolver(test_db, [user.id])

    assert creator_map[user.id].user_name == "creator-missing"
    assert creator_map[user.id].attributes == {}


@pytest.mark.asyncio
async def test_wecode_adapter_does_not_register_internal_mcp_tools():
    ensure_external_knowledge_tools_registered()

    tools = await external_knowledge_mcp_server.list_tools()

    tool_names = {tool.name for tool in tools}
    assert "wegent_kb_list_knowledge_bases" in tool_names
    assert "wecode_kb_list_knowledge_bases" not in tool_names
    assert all(not tool_name.startswith("wecode_") for tool_name in tool_names)


@pytest.mark.asyncio
async def test_wecode_same_name_tool_schema_exposes_employee_owner_filter():
    ensure_external_knowledge_tools_registered()

    tools = await external_knowledge_mcp_server.list_tools()

    list_tool = next(
        tool for tool in tools if tool.name == "wegent_kb_list_knowledge_bases"
    )
    assert "owner_employee_ids" in list_tool.inputSchema["properties"]
    assert "owner_user_ids" in list_tool.inputSchema["properties"]


@pytest.mark.asyncio
async def test_wecode_same_name_tool_converts_employee_ids_to_owner_user_ids():
    with (
        patch(
            "wecode.mcp_server.external_knowledge_tools.run_in_threadpool",
            new=AsyncMock(return_value=[123]),
        ) as run_in_threadpool,
        patch(
            "wecode.mcp_server.external_knowledge_tools."
            "knowledge_external.wegent_kb_list_knowledge_bases",
            new=AsyncMock(return_value='{"ok": true}'),
        ) as list_knowledge_bases,
    ):
        result = await wecode_wegent_kb_list_knowledge_bases(
            owner_employee_ids=["10007"]
        )

    assert json.loads(result) == {"ok": True}
    run_in_threadpool.assert_awaited_once()
    assert run_in_threadpool.await_args.args[1] == ["10007"]
    list_knowledge_bases.assert_awaited_once()
    assert list_knowledge_bases.await_args.kwargs["owner_user_ids"] == [123]


@pytest.mark.asyncio
async def test_wecode_same_name_tool_empty_employee_match_returns_empty_list():
    with (
        patch(
            "wecode.mcp_server.external_knowledge_tools.run_in_threadpool",
            new=AsyncMock(return_value=[]),
        ) as run_in_threadpool,
        patch(
            "wecode.mcp_server.external_knowledge_tools."
            "knowledge_external.wegent_kb_list_knowledge_bases",
            new=AsyncMock(return_value='{"unexpected": true}'),
        ) as list_knowledge_bases,
    ):
        result = await wecode_wegent_kb_list_knowledge_bases(
            owner_employee_ids=["missing"],
            limit=25,
            offset=10,
        )

    assert json.loads(result) == {
        "total": 0,
        "total_returned": 0,
        "has_more": False,
        "limit": 25,
        "offset": 10,
        "items": [],
    }
    run_in_threadpool.assert_awaited_once()
    list_knowledge_bases.assert_not_awaited()


@pytest.mark.asyncio
async def test_wecode_same_name_tool_does_not_hide_invalid_params_on_empty_match():
    with patch(
        "wecode.mcp_server.external_knowledge_tools.run_in_threadpool",
        new=AsyncMock(return_value=[]),
    ) as run_in_threadpool:
        result = await wecode_wegent_kb_list_knowledge_bases(
            owner_employee_ids=["missing"],
            limit=0,
        )

    assert json.loads(result) == {
        "error": "limit must be between 1 and 100",
        "code": "bad_request",
    }
    run_in_threadpool.assert_not_awaited()


@pytest.mark.asyncio
async def test_wecode_same_name_tool_rejects_mixed_owner_id_types():
    result = await wecode_wegent_kb_list_knowledge_bases(
        owner_user_ids=[123],
        owner_employee_ids=["10007"],
    )

    assert json.loads(result) == {
        "error": "owner_user_ids and owner_employee_ids cannot both be provided",
        "code": "bad_request",
    }
