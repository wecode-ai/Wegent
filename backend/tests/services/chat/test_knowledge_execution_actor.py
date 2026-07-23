# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

from app.services.chat.external_knowledge_refs import upsert_external_knowledge_refs
from app.services.chat.trigger.unified import _resolve_external_knowledge_scope


def _ref(source_id: str, provider: str = "demo-source") -> dict:
    return {
        "provider": provider,
        "mode": "explicit",
        "id": source_id,
        "name": source_id,
    }


def _task(default_refs: list[dict]) -> Mock:
    task = Mock()
    task.id = 1
    task.json = {
        "spec": {
            "teamRef": {"name": "shared-agent", "user_id": 7},
            "externalKnowledgeRefs": default_refs,
        }
    }
    return task


def test_shared_user_runs_default_dingtalk_and_ap_as_team_owner() -> None:
    owner = Mock(id=7, user_name="owner")
    sender = Mock(id=42, user_name="member")
    default_refs = [
        _ref("owner-dingtalk", "dingtalk"),
        _ref("owner-ap", "ap"),
    ]

    with (
        patch(
            "app.services.chat.trigger.unified."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=owner,
        ) as resolve_owner,
        patch(
            "app.services.chat.trigger.unified.filter_valid_external_knowledge_refs",
            return_value=(default_refs, []),
        ) as filter_refs,
        patch(
            "app.services.chat.trigger.unified.lock_task_for_knowledge_update",
            side_effect=lambda db, task: task,
        ),
        patch("app.services.chat.trigger.unified.replace_task_context_warnings"),
    ):
        refs, actor = _resolve_external_knowledge_scope(
            db=Mock(),
            task=_task(default_refs),
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=False,
            explicit_refs=[],
        )

    assert refs == default_refs
    assert actor is owner
    assert filter_refs.call_args.kwargs["actor_user_id"] == 7
    resolve_owner.assert_called_once()


def test_explicit_external_selection_uses_sender_for_only_that_execution() -> None:
    sender = Mock(id=42, user_name="member")
    default_ref = _ref("owner-default")
    explicit_ref = _ref("member-explicit")

    with (
        patch(
            "app.services.chat.trigger.unified."
            "KnowledgeBindingResolver.resolve_task_owner_user"
        ) as resolve_owner,
        patch(
            "app.services.chat.trigger.unified.filter_valid_external_knowledge_refs",
            side_effect=lambda refs, **_: (refs, []),
        ) as filter_refs,
    ):
        explicit_refs, explicit_actor = _resolve_external_knowledge_scope(
            db=Mock(),
            task=_task([default_ref]),
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=True,
            explicit_refs=[explicit_ref],
        )

    assert explicit_refs == [explicit_ref]
    assert explicit_actor is sender
    assert filter_refs.call_args.kwargs["actor_user_id"] == 42
    resolve_owner.assert_not_called()


def test_next_execution_without_explicit_selection_restores_owner_default() -> None:
    owner = Mock(id=7, user_name="owner")
    sender = Mock(id=42, user_name="member")
    default_ref = _ref("owner-default")
    explicit_ref = _ref("member-explicit")
    task = _task([default_ref])

    with (
        patch(
            "app.services.chat.trigger.unified."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=owner,
        ),
        patch(
            "app.services.chat.trigger.unified.filter_valid_external_knowledge_refs",
            side_effect=lambda refs, **_: (refs, []),
        ),
        patch(
            "app.services.chat.trigger.unified.lock_task_for_knowledge_update",
            side_effect=lambda db, task: task,
        ),
        patch("app.services.chat.trigger.unified.replace_task_context_warnings"),
    ):
        first_refs, first_actor = _resolve_external_knowledge_scope(
            db=Mock(),
            task=task,
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=True,
            explicit_refs=[explicit_ref],
        )
        next_refs, next_actor = _resolve_external_knowledge_scope(
            db=Mock(),
            task=task,
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=False,
            explicit_refs=[],
        )

    assert first_refs == [explicit_ref]
    assert first_actor is sender
    assert next_refs == [default_ref]
    assert next_actor is owner
    assert task.json["spec"]["externalKnowledgeRefs"] == [default_ref]


def test_explicit_source_is_current_only_then_task_inherits_accumulated_sources() -> (
    None
):
    owner = Mock(id=7, user_name="owner")
    sender = Mock(id=42, user_name="member")
    source_a = _ref("source-a")
    source_b = _ref("source-b")
    task = _task([source_a])

    with (
        patch(
            "app.services.chat.trigger.unified."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=owner,
        ),
        patch(
            "app.services.chat.trigger.unified.filter_valid_external_knowledge_refs",
            side_effect=lambda refs, **_: (refs, []),
        ),
        patch(
            "app.services.chat.trigger.unified.lock_task_for_knowledge_update",
            side_effect=lambda db, task: task,
        ),
        patch("app.services.chat.trigger.unified.replace_task_context_warnings"),
    ):
        current_refs, _ = _resolve_external_knowledge_scope(
            db=Mock(),
            task=task,
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=True,
            explicit_refs=[source_b],
        )
        task.json["spec"]["externalKnowledgeRefs"] = upsert_external_knowledge_refs(
            [source_a], [source_b]
        )
        next_refs, next_actor = _resolve_external_knowledge_scope(
            db=Mock(),
            task=task,
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=False,
            explicit_refs=[],
        )

    assert current_refs == [source_b]
    assert next_refs == [source_a, source_b]
    assert next_actor is owner


def test_missing_owner_never_falls_back_to_sender() -> None:
    sender = Mock(id=42, user_name="member")
    default_ref = _ref("owner-default")

    with (
        patch(
            "app.services.chat.trigger.unified."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=None,
        ),
        patch(
            "app.services.chat.trigger.unified.filter_valid_external_knowledge_refs"
        ) as filter_refs,
        patch(
            "app.services.chat.trigger.unified.lock_task_for_knowledge_update",
            side_effect=lambda db, task: task,
        ),
        patch(
            "app.services.chat.trigger.unified.replace_task_context_warnings"
        ) as replace_warnings,
    ):
        refs, actor = _resolve_external_knowledge_scope(
            db=Mock(),
            task=_task([default_ref]),
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=False,
            explicit_refs=[],
        )

    assert refs == []
    assert actor is None
    filter_refs.assert_not_called()
    warning = replace_warnings.call_args.kwargs["warnings"][0]
    assert warning["reason"] == "actor_not_found"


def test_revoked_owner_authorization_does_not_mutate_task() -> None:
    owner = Mock(id=7, user_name="owner")
    sender = Mock(id=42, user_name="member")
    default_ref = _ref("revoked-default")
    warning = {
        "type": "external_knowledge",
        "reason": "access_denied",
        "provider": "demo-source",
        "id": "revoked-default",
    }

    task = _task([default_ref])
    with (
        patch(
            "app.services.chat.trigger.unified."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=owner,
        ),
        patch(
            "app.services.chat.trigger.unified.filter_valid_external_knowledge_refs",
            return_value=([], [warning]),
        ),
        patch(
            "app.services.chat.trigger.unified.lock_task_for_knowledge_update",
            side_effect=lambda db, task: task,
        ),
        patch(
            "app.services.chat.trigger.unified.replace_task_context_warnings"
        ) as replace_warnings,
    ):
        refs, actor = _resolve_external_knowledge_scope(
            db=Mock(),
            task=task,
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=False,
            explicit_refs=[],
        )

    assert refs == []
    assert actor is owner
    assert task.json["spec"]["externalKnowledgeRefs"] == [default_ref]
    assert replace_warnings.call_args.kwargs["warnings"] == [warning]


def test_recovered_default_source_clears_same_scope_warning() -> None:
    owner = Mock(id=7, user_name="owner")
    sender = Mock(id=42, user_name="member")
    default_ref = _ref("restored")
    task = _task([default_ref])

    with (
        patch(
            "app.services.chat.trigger.unified."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=owner,
        ),
        patch(
            "app.services.chat.trigger.unified.filter_valid_external_knowledge_refs",
            return_value=([default_ref], []),
        ),
        patch(
            "app.services.chat.trigger.unified.lock_task_for_knowledge_update",
            return_value=task,
        ),
        patch(
            "app.services.chat.trigger.unified.replace_task_context_warnings"
        ) as replace_warnings,
    ):
        refs, actor = _resolve_external_knowledge_scope(
            db=Mock(),
            task=task,
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=False,
            explicit_refs=[],
        )

    assert refs == [default_ref]
    assert actor is owner
    assert replace_warnings.call_args.kwargs["warnings"] == []


def test_explicit_runtime_path_does_not_replace_default_warning_scope() -> None:
    sender = Mock(id=42, user_name="member")
    explicit_ref = _ref("explicit")

    with (
        patch(
            "app.services.chat.trigger.unified.filter_valid_external_knowledge_refs",
            return_value=([explicit_ref], []),
        ),
        patch(
            "app.services.chat.trigger.unified.replace_task_context_warnings"
        ) as replace_warnings,
    ):
        refs, actor = _resolve_external_knowledge_scope(
            db=Mock(),
            task=_task([_ref("default")]),
            team=Mock(user_id=7),
            sender=sender,
            has_explicit_selection=True,
            explicit_refs=[explicit_ref],
        )

    assert refs == [explicit_ref]
    assert actor is sender
    replace_warnings.assert_not_called()
