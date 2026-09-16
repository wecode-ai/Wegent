# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The manual trigger has the same scope and execution guards as daily sync."""

import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate, KnowledgeBaseUpdate
from app.services.knowledge.knowledge_service import KnowledgeService


@pytest.mark.parametrize(
    "scenario,expected",
    [("enabled", 202), ("disabled", 400), ("denied", 403), ("broker", 503)],
)
def test_manual_trigger_checks_access_and_queues_only_requested_kb(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    scenario: str,
    expected: int,
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="manual-sync")
    )
    KnowledgeService.update_knowledge_base(
        test_db,
        kb_id,
        test_user.id,
        KnowledgeBaseUpdate(dingtalk_auto_sync_enabled=scenario != "disabled"),
    )
    dispatch = MagicMock(return_value=SimpleNamespace(id="sync-task"))
    if scenario == "broker":
        dispatch.side_effect = RuntimeError("broker unavailable")
    monkeypatch.setattr(
        "app.tasks.dingtalk_auto_sync_tasks.scan_dingtalk_copies.apply_async", dispatch
    )
    if scenario == "denied":
        monkeypatch.setattr(
            KnowledgeService, "can_manage_knowledge_base", lambda *args: False
        )
    response = test_client.post(
        f"/api/knowledge-bases/{kb_id}/dingtalk-sync",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert response.status_code == expected
    if expected == 202:
        assert response.json() == {"task_id": "sync-task", "status": "queued"}
        dispatch.assert_called_once_with(args=[kb_id], expires=86400)
    elif expected in (400, 403):
        dispatch.assert_not_called()


def test_manual_trigger_requires_login(test_client: TestClient) -> None:
    assert test_client.post("/api/knowledge-bases/1/dingtalk-sync").status_code == 401


def test_manual_trigger_logs_the_queued_scan_task(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="logged-manual-sync", dingtalk_auto_sync_enabled=True),
    )
    monkeypatch.setattr(
        "app.tasks.dingtalk_auto_sync_tasks.scan_dingtalk_copies.apply_async",
        MagicMock(return_value=SimpleNamespace(id="sync-task")),
    )

    with caplog.at_level(logging.INFO):
        response = test_client.post(
            f"/api/knowledge-bases/{kb_id}/dingtalk-sync",
            headers={"Authorization": f"Bearer {test_token}"},
        )

    assert response.status_code == 202
    line = next(
        record.getMessage()
        for record in caplog.records
        if "decision=scan_queued" in record.getMessage()
    )
    assert f"kb_id={kb_id}" in line
    assert "task_id=sync-task" in line


@pytest.mark.parametrize("initial_enabled", [False, True])
def test_auto_sync_setting_survives_create_update_and_reload(
    test_client: TestClient, test_token: str, initial_enabled: bool
) -> None:
    headers = {"Authorization": f"Bearer {test_token}"}
    created = test_client.post(
        "/api/knowledge-bases",
        headers=headers,
        json={
            "name": "persist-auto-sync",
            "rag_config_mode": "disabled",
            "dingtalk_auto_sync_enabled": initial_enabled,
        },
    )
    assert created.status_code == 201
    kb_id = created.json()["id"]
    assert created.json()["dingtalk_auto_sync_enabled"] is initial_enabled
    for enabled in (False, True):
        saved = test_client.put(
            f"/api/knowledge-bases/{kb_id}",
            headers=headers,
            json={"dingtalk_auto_sync_enabled": enabled},
        )
        assert saved.status_code == 200
        assert saved.json()["dingtalk_auto_sync_enabled"] is enabled
        loaded = test_client.get(f"/api/knowledge-bases/{kb_id}", headers=headers)
        assert loaded.status_code == 200
        assert loaded.json()["dingtalk_auto_sync_enabled"] is enabled
    # Saving an unrelated field must preserve the existing enabled value.
    updated = test_client.put(
        f"/api/knowledge-bases/{kb_id}",
        headers=headers,
        json={"description": "updated"},
    )
    assert updated.status_code == 200
    assert (
        test_client.get(f"/api/knowledge-bases/{kb_id}", headers=headers).json()[
            "dingtalk_auto_sync_enabled"
        ]
        is True
    )
