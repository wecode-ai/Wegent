# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.schemas.knowledge import KnowledgeBaseCreate
from app.services.knowledge import KnowledgeService


def test_external_import_creates_document(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
):
    raw_key, _ = test_api_key
    kb_id = KnowledgeService.create_knowledge_base(
        db=test_db,
        user_id=test_user.id,
        data=KnowledgeBaseCreate(name="External Import KB"),
    )
    test_db.commit()

    payload = {
        "title": "Weibo Clip",
        "content": "Hello Wegent external import.",
        "source": "weibo",
        "source_url": "https://weibo.com/example",
        "external_id": "weibo-123",
        "author": "alice",
        "tags": ["social", "clip"],
        "metadata": {"channel": "mentions"},
    }

    response = test_client.post(
        f"/api/knowledge-bases/{kb_id}/external-imports",
        json=payload,
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 201
    data = response.json()
    assert data["knowledge_base_id"] == kb_id
    assert data["index_scheduled"] is False
    assert data["document"]["source_type"] == "text"
    assert data["document"]["source_config"]["source"] == "weibo"
