# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User


def _create_kb_with_summary(
    test_db: Session,
    test_user: User,
    *,
    summary_enabled: bool = True,
    summary: dict | None = None,
) -> Kind:
    kb = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name=f"summary-kb-{test_user.id}-{datetime.now().timestamp()}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": "summary-kb",
                "namespace": "default",
            },
            "spec": {
                "name": "Summary KB",
                "description": "Knowledge base for summary endpoint tests",
                "summaryEnabled": summary_enabled,
                "summary": summary,
            },
            "status": {"state": "Available"},
        },
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    test_db.add(kb)
    test_db.commit()
    test_db.refresh(kb)
    return kb


def test_update_kb_summary_rejects_whitespace_only_content(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
):
    kb = _create_kb_with_summary(
        test_db,
        test_user,
        summary={"status": "pending"},
    )

    response = test_client.put(
        f"/api/knowledge-bases/{kb.id}/summary",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"long_summary": "   "},
    )

    assert response.status_code == 422
    body = response.json()
    assert body["detail"] == "Request parameter validation failed"


def test_update_kb_summary_preserves_ai_status(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
):
    kb = _create_kb_with_summary(
        test_db,
        test_user,
        summary={"status": "pending"},
    )

    response = test_client.put(
        f"/api/knowledge-bases/{kb.id}/summary",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"long_summary": "Manual summary"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["status"] == "pending"
    assert body["summary"]["manual_long_summary"] == "Manual summary"
