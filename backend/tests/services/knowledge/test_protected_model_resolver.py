# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.knowledge.protected_model_resolver import ProtectedModelResolver


def test_load_knowledge_base_snapshots_preserves_request_order() -> None:
    resolver = ProtectedModelResolver()
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = [
        SimpleNamespace(
            id=2,
            json={
                "spec": {
                    "name": "KB-2",
                    "summaryModelRef": {"name": "summary-b"},
                }
            },
        ),
        SimpleNamespace(
            id=1,
            json={
                "spec": {
                    "name": "KB-1",
                    "summaryModelRef": {"name": "summary-a"},
                }
            },
        ),
    ]

    snapshots = resolver.load_knowledge_base_snapshots(
        db=db,
        knowledge_base_ids=[1, 2],
    )

    assert snapshots == [
        {
            "id": 1,
            "name": "KB-1",
            "summary_model_ref": {"name": "summary-a"},
        },
        {
            "id": 2,
            "name": "KB-2",
            "summary_model_ref": {"name": "summary-b"},
        },
    ]


def test_summary_model_fallback_dedupes_identical_refs() -> None:
    resolver = ProtectedModelResolver()
    db = MagicMock()
    model_kind = SimpleNamespace(json={"spec": {"provider": "openai"}})

    with (
        patch.object(
            resolver,
            "_lookup_model_kind",
            return_value=(model_kind, "public"),
        ) as mock_lookup,
        patch(
            "app.services.knowledge.protected_model_resolver.extract_and_process_model_config",
            return_value={"model_id": "gpt-summary"},
        ),
    ):
        result = resolver._resolve_summary_or_system_fallback(
            db=db,
            knowledge_base_ids=[1, 2],
            knowledge_base_snapshots=[
                {
                    "id": 1,
                    "name": "KB-1",
                    "summary_model_ref": {
                        "name": "summary-model",
                        "namespace": "default",
                        "type": "public",
                    },
                },
                {
                    "id": 2,
                    "name": "KB-2",
                    "summary_model_ref": {
                        "name": "summary-model",
                        "namespace": "default",
                        "type": "public",
                    },
                },
            ],
            user_id=7,
            user_name="alice",
        )

    mock_lookup.assert_called_once_with(
        db=db,
        model_name="summary-model",
        model_namespace="default",
        model_type="public",
        user_id=7,
    )
    assert result is not None
    assert result["model_id"] == "gpt-summary"
    assert result["model_name"] == "summary-model"
    assert result["model_namespace"] == "default"
