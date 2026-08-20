# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP contract tests for the shared knowledge-base retrieval profile."""

from app.models.system_config import SystemConfig
from app.services.knowledge.retrieval_profile import (
    KNOWLEDGE_BASE_RETRIEVAL_PROFILE_KEY,
)


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_authenticated_users_receive_only_safe_profile_references(
    test_client, test_db, test_token
) -> None:
    test_db.add(
        SystemConfig(
            config_key=KNOWLEDGE_BASE_RETRIEVAL_PROFILE_KEY,
            config_value={
                "retrieval_config": {
                    "retriever_name": "shared-retriever",
                    "embedding_config": {"model_name": "shared-embedding"},
                    "connection": {"password": "must-not-leak"},
                }
            },
            version=3,
        )
    )
    test_db.commit()

    response = test_client.get(
        "/api/knowledge-bases/code-wiki-retrieval-profile",
        headers=_headers(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["version"] == 3
    assert payload["retrieval_config"] == {
        "retriever_name": "shared-retriever",
        "retriever_namespace": "default",
        "embedding_config": {
            "model_name": "shared-embedding",
            "model_namespace": "default",
        },
        "retrieval_mode": "vector",
        "top_k": 5,
        "score_threshold": 0.5,
        "hybrid_weights": None,
    }
    assert "password" not in response.text
    assert "connection" not in response.text


def test_non_admin_cannot_change_the_retrieval_profile(test_client, test_token) -> None:
    response = test_client.put(
        "/api/admin/system-config/code-wiki-retrieval-profile",
        json={
            "retrieval_config": {
                "retriever_name": "shared-retriever",
                "embedding_config": {"model_name": "shared-embedding"},
            }
        },
        headers=_headers(test_token),
    )

    assert response.status_code == 403
