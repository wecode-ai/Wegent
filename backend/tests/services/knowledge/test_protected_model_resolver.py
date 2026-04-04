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
    unique_refs = resolver._collect_unique_summary_model_refs(
        [
            {
                "id": 1,
                "name": "KB-1",
                "summary_model_ref": {
                    "name": "summary-model",
                    "namespace": "default",
                },
            },
            {
                "id": 2,
                "name": "KB-2",
                "summary_model_ref": {
                    "name": "summary-model",
                    "namespace": "default",
                },
            },
            {
                "id": 3,
                "name": "KB-3",
                "summary_model_ref": {
                    "name": "summary-model-2",
                    "namespace": "group-a",
                    "type": "group",
                },
            },
        ]
    )

    assert unique_refs == [
        {
            "name": "summary-model",
            "namespace": "default",
            "type": None,
        },
        {
            "name": "summary-model-2",
            "namespace": "group-a",
            "type": "group",
        },
    ]


def test_summary_model_fallback_uses_resolved_kind_metadata() -> None:
    resolver = ProtectedModelResolver()
    db = MagicMock()
    db.query.return_value.filter.return_value.all.side_effect = [
        [],
        [
            SimpleNamespace(
                name="summary-model",
                namespace="default",
                json={"spec": {"provider": "openai"}},
            )
        ],
    ]

    with patch(
        "app.services.knowledge.protected_model_resolver.extract_and_process_model_config",
        return_value={"model_id": "gpt-summary"},
    ):
        result = resolver._resolve_summary_or_system_fallback(
            db=db,
            knowledge_base_ids=[1],
            knowledge_base_snapshots=[
                {
                    "id": 1,
                    "name": "KB-1",
                    "summary_model_ref": {
                        "name": "summary-model",
                        "namespace": "team-a",
                    },
                }
            ],
            user_id=7,
            user_name="alice",
        )

    assert db.query.return_value.filter.return_value.all.call_count == 2
    assert result is not None
    assert result["model_id"] == "gpt-summary"
    assert result["model_name"] == "summary-model"
    assert result["model_namespace"] == "default"
    assert result["model_type"] == "public"


def test_lookup_model_kind_keeps_named_model_resolution_behavior() -> None:
    resolver = ProtectedModelResolver()
    db = MagicMock()
    user_kind = SimpleNamespace(name="summary-model", namespace="team-a")

    with patch.object(
        resolver,
        "_get_user_scoped_model_kind",
        return_value=user_kind,
    ) as mock_get_user_kind:
        model_kind, model_type = resolver._lookup_model_kind(
            db=db,
            model_name="summary-model",
            model_namespace="team-a",
            model_type=None,
            user_id=7,
        )

    mock_get_user_kind.assert_called_once_with(
        db=db,
        model_name="summary-model",
        model_namespace="team-a",
        user_id=7,
    )
    assert model_kind is user_kind
    assert model_type == "group"


def test_lookup_model_kind_does_not_repeat_user_lookup_on_typed_miss() -> None:
    resolver = ProtectedModelResolver()
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None

    with patch.object(
        resolver,
        "_get_user_scoped_model_kind",
        return_value=None,
    ) as mock_get_user_kind:
        model_kind, model_type = resolver._lookup_model_kind(
            db=db,
            model_name="summary-model",
            model_namespace="team-a",
            model_type="group",
            user_id=7,
        )

    mock_get_user_kind.assert_called_once_with(
        db=db,
        model_name="summary-model",
        model_namespace="team-a",
        user_id=7,
    )
    assert model_kind is None
    assert model_type is None


def test_resolve_named_model_uses_resolved_kind_metadata() -> None:
    resolver = ProtectedModelResolver()
    db = MagicMock()
    public_kind = SimpleNamespace(
        name="main-model",
        namespace="default",
        json={"spec": {"provider": "openai"}},
    )

    with (
        patch.object(
            resolver,
            "_lookup_model_kind",
            return_value=(public_kind, "public"),
        ) as mock_lookup,
        patch(
            "app.services.knowledge.protected_model_resolver.extract_and_process_model_config",
            return_value={"model_id": "gpt-main"},
        ),
    ):
        result = resolver._resolve_named_model(
            db=db,
            model_name="main-model",
            model_namespace="team-a",
            user_id=7,
            user_name="alice",
        )

    mock_lookup.assert_called_once_with(
        db=db,
        model_name="main-model",
        model_namespace="team-a",
        model_type=None,
        user_id=7,
    )
    assert result == {
        "model_id": "gpt-main",
        "model_name": "main-model",
        "model_namespace": "default",
        "model_type": "public",
    }
