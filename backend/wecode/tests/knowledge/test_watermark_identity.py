# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from wecode.service.knowledge.watermark_identity import (
    resolve_watermark_identity,
)


def test_resolve_watermark_identity_from_company_profile() -> None:
    user = SimpleNamespace(
        user_name="fallback",
        preferences=json.dumps(
            {
                "company_profile": {
                    "name": " 张三 ",
                    "employee_id": " 10001 ",
                }
            }
        ),
    )

    identity = resolve_watermark_identity(user)

    assert identity.display_name == "张三"
    assert identity.employee_id == "10001"


def test_resolve_watermark_identity_falls_back_to_login_identity() -> None:
    user = SimpleNamespace(
        id=7,
        user_name="张三",
        preferences={"company_profile": {"name": "张三"}},
    )

    identity = resolve_watermark_identity(user)

    assert identity.display_name == "张三"
    assert identity.employee_id == "7"


def test_resolve_watermark_identity_ignores_invalid_profile_name() -> None:
    user = SimpleNamespace(
        id=8,
        user_name="fallback",
        preferences={
            "company_profile": {
                "name": "张三\n管理员",
                "employee_id": "10001",
            }
        },
    )

    identity = resolve_watermark_identity(user)

    assert identity.display_name == "fallback"
    assert identity.employee_id == "10001"


def test_resolve_watermark_identity_falls_back_to_cached_erp_user() -> None:
    user = SimpleNamespace(id=7, user_name="fallback", preferences={})
    query = MagicMock()
    query.filter.return_value = query
    query.first.return_value = SimpleNamespace(
        erp_name="李四",
        employee_id="10002",
    )
    db = MagicMock()
    db.query.return_value = query

    identity = resolve_watermark_identity(user, db)

    assert identity.display_name == "李四"
    assert identity.employee_id == "10002"


def test_resolve_watermark_identity_lazily_syncs_erp_user(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = SimpleNamespace(id=7, user_name="fallback", preferences={})
    empty_query = MagicMock()
    empty_query.filter.return_value = empty_query
    empty_query.first.return_value = None
    db = MagicMock()
    db.query.return_value = empty_query
    synced_query = MagicMock()
    synced_query.filter.return_value = synced_query
    synced_query.first.return_value = SimpleNamespace(
        erp_name="王五",
        employee_id="10003",
    )
    synced_db = MagicMock()
    synced_db.query.return_value = synced_query
    monkeypatch.setattr(
        "wecode.service.knowledge.watermark_identity.ErpEntityResolver.resolve_employee_id",
        lambda self, _db, _user_id: "10003",
    )
    monkeypatch.setattr("app.db.session.SessionLocal", lambda: synced_db)

    identity = resolve_watermark_identity(user, db)

    assert identity.display_name == "王五"
    assert identity.employee_id == "10003"
    db.expire_all.assert_not_called()
    synced_db.close.assert_called_once_with()
