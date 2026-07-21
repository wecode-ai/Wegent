# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.models.task import TaskResource
from app.services.chat.external_knowledge_refs import (
    build_external_ref_canonical_key,
    filter_valid_external_knowledge_refs,
    remove_task_external_knowledge_ref,
    replace_task_context_warnings,
    validate_external_knowledge_refs,
)
from app.services.chat.preprocessing.contexts import (
    _batch_update_and_insert_contexts,
    _filter_explicit_knowledge_contexts,
    _prepare_contexts_for_creation,
    _prepare_kb_tools_from_contexts,
    link_contexts_to_subtask,
)
from app.services.rag.sources import ExternalRefValidationError


def test_prepare_contexts_creates_canonical_internal_and_external_contexts() -> None:
    contexts = [
        SimpleNamespace(
            type="knowledge_base",
            data={"knowledge_id": 107, "name": "Internal", "document_count": 1},
        ),
        SimpleNamespace(
            type="external_knowledge",
            data={
                "external_ref": {
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "name": "External",
                    "target_type": "document",
                    "document_id": "doc-1",
                    "target_name": "Guide",
                }
            },
        ),
    ]

    kb_contexts, tables, selected_docs, external_contexts = (
        _prepare_contexts_for_creation(contexts, subtask_id=166, user_id=2)
    )

    assert tables == []
    assert selected_docs == []
    assert kb_contexts[0].type_data["knowledge_id"] == 107
    assert external_contexts[0].type_data == {
        "external_ref": contexts[1].data["external_ref"]
    }


def test_prepare_contexts_normalizes_legacy_flat_external_payload() -> None:
    _, _, _, external_contexts = _prepare_contexts_for_creation(
        [
            SimpleNamespace(
                type="external_knowledge",
                data={
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "name": "Legacy source",
                },
            )
        ],
        subtask_id=166,
        user_id=2,
    )

    assert external_contexts[0].type_data == {
        "external_ref": {
            "provider": "demo-source",
            "mode": "explicit",
            "id": "kb-1",
            "name": "Legacy source",
        }
    }


def test_link_contexts_upserts_message_knowledge_to_task() -> None:
    db = Mock()
    task = Mock(spec=TaskResource)
    task.id = 71
    contexts = [
        SimpleNamespace(type="knowledge_base", data={"knowledge_id": 107}),
        SimpleNamespace(
            type="external_knowledge",
            data={
                "provider": "demo-source",
                "mode": "explicit",
                "id": "kb-1",
            },
        ),
    ]

    with (
        patch(
            "app.services.chat.preprocessing.contexts._batch_update_and_insert_contexts",
            return_value=[83, 84],
        ) as batch_insert,
        patch(
            "app.services.chat.preprocessing.contexts._filter_explicit_knowledge_contexts",
            side_effect=lambda **kwargs: (
                kwargs["kb_contexts"],
                kwargs["external_contexts"],
                [],
                {"internal:107", "external:demo-source:explicit:kb-1:knowledge_base::"},
            ),
        ),
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "upsert_message_knowledge_bindings",
            return_value=task,
        ) as upsert_task_knowledge,
    ):
        linked_ids = link_contexts_to_subtask(
            db=db,
            subtask_id=166,
            user_id=2,
            contexts=contexts,
            task=task,
        )

    assert linked_ids == [83, 84]
    batch_insert.assert_called_once()
    upsert_task_knowledge.assert_called_once()


def test_filter_explicit_knowledge_marks_invalid_contexts_failed() -> None:
    internal_context = SimpleNamespace(
        knowledge_id=107,
        status="ready",
        error_message="",
    )
    external_context = SimpleNamespace(
        status="ready",
        error_message="",
        type_data={
            "external_ref": {
                "provider": "demo-source",
                "mode": "explicit",
                "id": "kb-1",
            }
        },
    )
    external_warning = {
        "type": "external_knowledge",
        "reason": "access_denied",
        "id": "kb-1",
    }

    with (
        patch(
            "app.services.chat.knowledge_binding_resolver."
            "KnowledgeBindingResolver.filter_internal_bindings",
            return_value=([], [{"type": "knowledge_base", "id": "107"}]),
        ),
        patch(
            "app.services.chat.external_knowledge_refs."
            "filter_valid_external_knowledge_refs",
            return_value=([], [external_warning]),
        ),
    ):
        internal, external, warnings, scope_keys = _filter_explicit_knowledge_contexts(
            db=Mock(),
            actor_user_id=42,
            kb_contexts=[internal_context],
            external_contexts=[external_context],
        )

    assert internal[0].status == "failed"
    assert external[0].status == "failed"
    assert warnings[-1] == external_warning
    assert scope_keys == {
        "internal:107",
        "external:demo-source:explicit:kb-1:knowledge_base:::",
    }


def test_rejected_explicit_internal_selection_does_not_fall_back_to_task() -> None:
    with patch(
        "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids"
    ) as get_task_defaults:
        result = _prepare_kb_tools_from_contexts(
            kb_contexts=[],
            user_id=42,
            db=Mock(),
            base_system_prompt="system",
            task_id=71,
            has_explicit_internal_knowledge=True,
        )

    assert result.knowledge_base_ids == []
    get_task_defaults.assert_not_called()


def test_validate_external_knowledge_refs_wraps_provider_value_errors() -> None:
    with patch(
        "app.services.rag.sources.validate_external_refs",
        side_effect=ValueError("too many sources"),
    ):
        try:
            validate_external_knowledge_refs(
                [{"provider": "demo-source", "mode": "explicit", "id": "kb-1"}],
                binding_level="conversation",
                actor_user_id=101,
            )
        except ExternalRefValidationError as exc:
            assert str(exc) == "too many sources"
        else:
            raise AssertionError("Expected ExternalRefValidationError")


def test_external_gate_batches_multiple_refs_on_success() -> None:
    refs = [
        {"provider": "ap", "mode": "explicit", "id": "kb-1"},
        {"provider": "ap", "mode": "explicit", "id": "kb-2"},
    ]

    with patch(
        "app.services.chat.external_knowledge_refs.validate_external_knowledge_refs"
    ) as validate:
        valid, warnings = filter_valid_external_knowledge_refs(
            refs,
            binding_level="conversation",
            actor_user_id=7,
        )

    assert valid == refs
    assert warnings == []
    validate.assert_called_once_with(
        refs,
        binding_level="conversation",
        actor_user_id=7,
    )


def test_remove_task_external_ref_removes_only_exact_target() -> None:
    db = Mock()
    task = Mock(spec=TaskResource)
    task.json = {
        "spec": {
            "externalKnowledgeRefs": [
                {
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "target_type": "document",
                    "document_id": "doc-1",
                },
                {
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "target_type": "document",
                    "document_id": "doc-2",
                },
            ]
        }
    }

    with patch(
        "app.services.chat.external_knowledge_refs.task_stores.task_store.update_json"
    ) as update_json:
        remaining = remove_task_external_knowledge_ref(
            db,
            task,
            {
                "provider": "demo-source",
                "mode": "explicit",
                "id": "kb-1",
                "target_type": "document",
                "document_id": "doc-1",
            },
        )

    assert [ref["document_id"] for ref in remaining] == ["doc-2"]
    update_json.assert_called_once()


def test_repaired_binding_replaces_stale_warning() -> None:
    db = Mock()
    task = Mock(spec=TaskResource)
    task.json = {
        "spec": {
            "contextWarnings": [
                {
                    "type": "external_knowledge",
                    "reason": "not_configured",
                    "id": "kb-1",
                    "metadata": {
                        "canonicalKey": (
                            "external:demo-source:explicit:kb-1:knowledge_base::"
                        )
                    },
                }
            ]
        }
    }

    with patch(
        "app.services.chat.external_knowledge_refs.task_stores.task_store.update_json"
    ) as update_json:
        warnings = replace_task_context_warnings(
            db,
            task,
            canonical_keys={"external:demo-source:explicit:kb-1:knowledge_base:::"},
            warnings=[],
        )

    assert warnings == []
    assert update_json.call_args.kwargs["payload"]["spec"]["contextWarnings"] == []


def test_batch_update_and_insert_contexts_flushes_without_commit() -> None:
    db = Mock()
    context = Mock()
    context.id = 91

    result = _batch_update_and_insert_contexts(
        db=db,
        attachment_ids=None,
        contexts_to_create=[context],
        subtask_id=166,
        task_id=71,
    )

    assert result == [91]
    db.add_all.assert_called_once_with([context])
    db.flush.assert_called_once()
    db.commit.assert_not_called()


def test_task_update_failure_rolls_back_before_context_insert() -> None:
    db = Mock()
    task = Mock(spec=TaskResource, id=71)
    contexts = [SimpleNamespace(type="knowledge_base", data={"knowledge_id": 107})]

    with (
        patch(
            "app.services.chat.preprocessing.contexts._filter_explicit_knowledge_contexts",
            side_effect=lambda **kwargs: (
                kwargs["kb_contexts"],
                kwargs["external_contexts"],
                [],
                {"internal:107"},
            ),
        ),
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "upsert_message_knowledge_bindings",
            side_effect=RuntimeError("task update failed"),
        ),
        patch(
            "app.services.chat.preprocessing.contexts._batch_update_and_insert_contexts"
        ) as batch_insert,
    ):
        with pytest.raises(RuntimeError, match="task update failed"):
            link_contexts_to_subtask(
                db=db,
                subtask_id=166,
                user_id=2,
                contexts=contexts,
                task=task,
            )

    batch_insert.assert_not_called()
    db.rollback.assert_called_once()
    db.commit.assert_not_called()


def test_context_insert_failure_rolls_back_task_update() -> None:
    db = Mock()
    task = Mock(spec=TaskResource, id=71)
    contexts = [SimpleNamespace(type="knowledge_base", data={"knowledge_id": 107})]

    with (
        patch(
            "app.services.chat.preprocessing.contexts._filter_explicit_knowledge_contexts",
            side_effect=lambda **kwargs: (
                kwargs["kb_contexts"],
                kwargs["external_contexts"],
                [],
                {"internal:107"},
            ),
        ),
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "upsert_message_knowledge_bindings",
            return_value=task,
        ) as upsert_task,
        patch(
            "app.services.chat.preprocessing.contexts._batch_update_and_insert_contexts",
            side_effect=RuntimeError("context insert failed"),
        ),
    ):
        with pytest.raises(RuntimeError, match="context insert failed"):
            link_contexts_to_subtask(
                db=db,
                subtask_id=166,
                user_id=2,
                contexts=contexts,
                task=task,
            )

    upsert_task.assert_called_once()
    db.rollback.assert_called_once()
    db.commit.assert_not_called()


def test_canonical_key_defaults_target_type_to_knowledge_base() -> None:
    """external ref canonical key must default missing target_type to knowledge_base."""
    ref_without_target = {
        "provider": "demo-source",
        "mode": "explicit",
        "id": "kb-1",
    }
    ref_with_target = {
        "provider": "demo-source",
        "mode": "explicit",
        "id": "kb-1",
        "target_type": "knowledge_base",
    }

    assert build_external_ref_canonical_key(
        ref_without_target
    ) == build_external_ref_canonical_key(ref_with_target)


def test_canonical_key_distinguishes_document_and_workspace_scope() -> None:
    """Different workspace/node/document combinations must produce different keys."""
    base = {
        "provider": "ap",
        "mode": "explicit",
        "id": "kb-1",
        "target_type": "knowledge_base",
    }
    whole = build_external_ref_canonical_key(base)
    document = build_external_ref_canonical_key(
        {**base, "target_type": "document", "document_id": "doc-1"}
    )
    workspace = build_external_ref_canonical_key({**base, "workspace_id": "ws-1"})

    assert len({whole, document, workspace}) == 3
