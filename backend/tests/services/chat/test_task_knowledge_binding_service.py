# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import ExitStack
from threading import Event, Lock, Thread, current_thread
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.services.chat.external_knowledge_refs import (
    filter_valid_external_knowledge_refs,
    upsert_external_knowledge_refs,
)
from app.services.chat.knowledge_binding_resolver import KnowledgeBindingResolver
from app.services.chat.task_knowledge_binding_service import (
    _group_internal_contexts,
    _replace_selected_warnings,
    upsert_internal_knowledge_bindings,
    upsert_message_knowledge_bindings,
)
from app.services.rag.sources.models import (
    ExternalProviderCapabilities,
    ExternalRefValidationResult,
)
from app.services.rag.sources.registry import retrieval_source_registry


def _snapshot(
    knowledge_base_id: int,
    *,
    scoped: bool = False,
    document_ids: list[int] | None = None,
    folder_ids: list[int] | None = None,
) -> dict:
    return {
        "id": knowledge_base_id,
        "name": f"KB {knowledge_base_id}",
        "namespace": "default",
        "scope_restricted": scoped,
        "document_ids": document_ids or [],
        "folder_ids": folder_ids or [],
        "include_subfolders": True,
        "boundBy": "sender",
        "boundAt": "2026-07-20T00:00:00+00:00",
    }


def _whole_ref(knowledge_base_id: int) -> dict:
    return {
        "id": knowledge_base_id,
        "name": f"KB {knowledge_base_id}",
        "boundBy": "sender",
        "boundAt": "earlier",
    }


def _scope_ref(
    knowledge_base_id: int,
    *,
    document_ids: list[int] | None = None,
    folder_ids: list[int] | None = None,
) -> dict:
    return {
        "id": knowledge_base_id,
        "namespace": "default",
        "name": f"KB {knowledge_base_id}",
        "scopeRestricted": True,
        "folderIds": folder_ids,
        "explicitDocumentIds": document_ids or [],
        "includeSubfolders": True,
        "boundBy": "sender",
        "boundAt": "earlier",
    }


@pytest.mark.unit
def test_internal_upsert_appends_a_different_knowledge_base() -> None:
    refs, scopes, rejected = upsert_internal_knowledge_bindings(
        [_whole_ref(1)],
        [],
        [_snapshot(2)],
        max_knowledge_bases=10,
    )

    assert [ref["id"] for ref in refs] == [1, 2]
    assert scopes == []
    assert rejected == []


@pytest.mark.unit
def test_internal_upsert_replaces_whole_with_scope() -> None:
    refs, scopes, rejected = upsert_internal_knowledge_bindings(
        [_whole_ref(1)],
        [],
        [_snapshot(1, scoped=True, document_ids=[10])],
        max_knowledge_bases=10,
    )

    assert refs == []
    assert scopes[0]["id"] == 1
    assert scopes[0]["explicitDocumentIds"] == [10]
    assert rejected == []


@pytest.mark.unit
def test_internal_upsert_replaces_scope_with_whole() -> None:
    refs, scopes, rejected = upsert_internal_knowledge_bindings(
        [],
        [_scope_ref(1, document_ids=[10])],
        [_snapshot(1)],
        max_knowledge_bases=10,
    )

    assert [ref["id"] for ref in refs] == [1]
    assert scopes == []
    assert rejected == []


@pytest.mark.unit
def test_internal_upsert_replaces_old_folder_scope() -> None:
    refs, scopes, _ = upsert_internal_knowledge_bindings(
        [],
        [_scope_ref(1, folder_ids=[7])],
        [_snapshot(1, scoped=True, folder_ids=[8])],
        max_knowledge_bases=10,
    )

    assert refs == []
    assert scopes[0]["folderIds"] == [8]


@pytest.mark.unit
def test_same_request_internal_targets_are_merged_before_upsert() -> None:
    contexts = [
        SimpleNamespace(
            knowledge_id=1,
            type_data={
                "scope_restricted": True,
                "document_ids": [10],
                "folder_ids": [7],
            },
        ),
        SimpleNamespace(
            knowledge_id=1,
            type_data={
                "scope_restricted": True,
                "document_ids": [11, 10],
                "folder_ids": [8],
            },
        ),
    ]

    grouped = _group_internal_contexts(contexts)

    assert grouped[1]["document_ids"] == [10, 11]
    assert grouped[1]["folder_ids"] == [7, 8]


@pytest.mark.unit
def test_internal_limit_counts_unique_whole_and_scoped_ids() -> None:
    refs = [_whole_ref(knowledge_base_id) for knowledge_base_id in range(1, 10)]
    scopes = [_scope_ref(10, document_ids=[100])]

    next_refs, next_scopes, rejected = upsert_internal_knowledge_bindings(
        refs,
        scopes,
        [_snapshot(11)],
        max_knowledge_bases=10,
    )

    assert next_refs == refs
    assert next_scopes == scopes
    assert rejected == [11]


@pytest.mark.unit
def test_external_upsert_replaces_same_source_document_snapshot() -> None:
    existing = [
        {
            "provider": "ap",
            "mode": "explicit",
            "id": "source-a",
            "target_type": "document",
            "document_id": "old",
        }
    ]
    incoming = [
        {
            "provider": "ap",
            "mode": "explicit",
            "id": "source-a",
            "target_type": "document",
            "document_id": "new",
        }
    ]

    result = upsert_external_knowledge_refs(existing, incoming)

    assert [ref["document_id"] for ref in result] == ["new"]


@pytest.mark.unit
def test_external_upsert_appends_different_source() -> None:
    existing = [{"provider": "ap", "mode": "explicit", "id": "source-a"}]
    incoming = [{"provider": "ap", "mode": "explicit", "id": "source-b"}]

    result = upsert_external_knowledge_refs(existing, incoming)

    assert [ref["id"] for ref in result] == ["source-a", "source-b"]


@pytest.mark.unit
def test_external_upsert_keeps_all_targets_from_same_request() -> None:
    existing = [{"provider": "ap", "mode": "explicit", "id": "source-a"}]
    incoming = [
        {
            "provider": "ap",
            "mode": "explicit",
            "id": "source-a",
            "target_type": "document",
            "document_id": "doc-1",
        },
        {
            "provider": "ap",
            "mode": "explicit",
            "id": "source-a",
            "target_type": "folder",
            "node_id": "folder-1",
        },
    ]

    result = upsert_external_knowledge_refs(existing, incoming)

    assert {ref["target_type"] for ref in result} == {"document", "folder"}
    assert all(ref.get("target_type") != "knowledge_base" for ref in result)


@pytest.mark.unit
def test_whole_external_binding_keeps_whole_and_warns_for_child(monkeypatch) -> None:
    provider = SimpleNamespace(
        name="batch-provider",
        capabilities=ExternalProviderCapabilities(enforces_per_user_access=True),
        validate_refs_batch=lambda *, gate: [
            ExternalRefValidationResult(ref=ref) for ref in gate.refs
        ],
    )
    monkeypatch.setitem(
        retrieval_source_registry._providers,
        provider.name,
        provider,
    )
    whole = {
        "provider": provider.name,
        "mode": "explicit",
        "id": "source-a",
        "target_type": "knowledge_base",
    }
    child = {
        "provider": provider.name,
        "mode": "explicit",
        "id": "source-a",
        "target_type": "document",
        "document_id": "doc-1",
        "target_name": "Child",
    }

    valid, warnings = filter_valid_external_knowledge_refs(
        [child, whole],
        binding_level="conversation",
        actor_user_id=7,
    )

    assert valid == [whole]
    assert warnings[0]["reason"] == "unsupported_binding"
    assert warnings[0]["name"] == "Child"


@pytest.mark.unit
def test_batch_provider_returns_per_ref_results_in_one_call(monkeypatch) -> None:
    calls = []

    def validate_batch(*, gate):
        calls.append(gate)
        return [
            ExternalRefValidationResult(
                ref=ref,
                reason="inactive_or_deleted" if ref.id == "bad" else None,
            )
            for ref in gate.refs
        ]

    provider = SimpleNamespace(
        name="batch-provider",
        capabilities=ExternalProviderCapabilities(enforces_per_user_access=True),
        validate_refs_batch=validate_batch,
    )
    monkeypatch.setitem(
        retrieval_source_registry._providers,
        provider.name,
        provider,
    )
    refs = [
        {"provider": provider.name, "mode": "explicit", "id": source_id}
        for source_id in ("one", "bad", "two")
    ]

    valid, warnings = filter_valid_external_knowledge_refs(
        refs,
        binding_level="conversation",
        actor_user_id=7,
    )

    assert len(calls) == 1
    assert [ref["id"] for ref in valid] == ["one", "two"]
    assert [(warning["id"], warning["reason"]) for warning in warnings] == [
        ("bad", "inactive_or_deleted")
    ]


@pytest.mark.unit
def test_external_source_upsert_clears_old_target_warning() -> None:
    old_warning = {
        "type": "external_knowledge",
        "reason": "access_denied",
        "id": "source-a",
        "metadata": {"canonicalKey": "external:ap:explicit:source-a:document::old"},
    }
    new_key = "external:ap:explicit:source-a:document::new"

    warnings = _replace_selected_warnings([old_warning], {new_key}, [])

    assert warnings == []


def _context(
    *,
    knowledge_id: int | None = None,
    external_ref: dict | None = None,
    status: str = "ready",
) -> SimpleNamespace:
    return SimpleNamespace(
        knowledge_id=knowledge_id,
        status=status,
        type_data={"external_ref": external_ref} if external_ref else {},
    )


def _task(spec: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(id=71, json={"spec": spec or {}})


def _service_dependencies(task, *, owner=None):
    actor = SimpleNamespace(id=2, user_name="sender")
    task_store = patch(
        "app.services.chat.task_knowledge_binding_service."
        "task_stores.task_store.get_by_id_for_update",
        return_value=task,
    )
    active_user = patch(
        "app.services.chat.task_knowledge_binding_service._get_active_user",
        return_value=actor,
    )
    task_owner = patch(
        "app.services.chat.task_knowledge_binding_service."
        "KnowledgeBindingResolver.resolve_task_owner_user",
        return_value=owner or SimpleNamespace(id=1),
    )
    return task_store, active_user, task_owner


@pytest.mark.unit
def test_public_team_task_uses_task_resource_owner() -> None:
    owner = SimpleNamespace(id=42, is_active=True)
    db = Mock()
    db.query.return_value.filter.return_value.first.return_value = owner
    task = SimpleNamespace(
        user_id=42,
        json={"spec": {"teamRef": {"user_id": 0}}},
    )

    result = KnowledgeBindingResolver(db).resolve_task_owner_user(task=task)

    assert result is owner
    filters = db.query.return_value.filter.call_args.args
    assert filters[0].right.value == 42


@pytest.mark.unit
def test_no_knowledge_context_does_not_lock_or_update_task() -> None:
    task = _task()
    with patch(
        "app.services.chat.task_knowledge_binding_service."
        "task_stores.task_store.get_by_id_for_update"
    ) as lock_task:
        result = upsert_message_knowledge_bindings(Mock(), task, [], [], 2)

    assert result is task
    lock_task.assert_not_called()


@pytest.mark.unit
def test_failed_context_without_warning_does_not_modify_task() -> None:
    task = _task({"knowledgeBaseRefs": [_whole_ref(1)]})
    failed_context = _context(knowledge_id=2, status="failed")
    with patch(
        "app.services.chat.task_knowledge_binding_service."
        "task_stores.task_store.get_by_id_for_update"
    ) as lock_task:
        result = upsert_message_knowledge_bindings(
            Mock(), task, [failed_context], [], 2
        )

    assert result is task
    lock_task.assert_not_called()


@pytest.mark.unit
def test_sender_and_owner_access_persists_internal_binding_once() -> None:
    task = _task()
    context = _context(knowledge_id=2)
    dependencies = _service_dependencies(task)
    with (
        dependencies[0],
        dependencies[1],
        dependencies[2],
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "_filter_internal_for_owner",
            return_value=([context], []),
        ),
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "_build_internal_snapshots",
            return_value=[_snapshot(2)],
        ),
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "task_stores.task_store.update_json",
            side_effect=lambda db, *, task, payload: setattr(task, "json", payload),
        ) as update_json,
    ):
        upsert_message_knowledge_bindings(Mock(), task, [context], [], 2)

    assert [ref["id"] for ref in task.json["spec"]["knowledgeBaseRefs"]] == [2]
    update_json.assert_called_once()


@pytest.mark.unit
def test_owner_denial_keeps_current_context_ready_without_persisting() -> None:
    existing = _whole_ref(1)
    task = _task({"knowledgeBaseRefs": [existing]})
    context = _context(knowledge_id=2)
    owner_warning = {
        "type": "knowledge_base",
        "reason": "access_denied",
        "id": "2",
        "metadata": {"canonicalKey": "internal:2"},
    }
    dependencies = _service_dependencies(task)
    with (
        dependencies[0],
        dependencies[1],
        dependencies[2],
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "_filter_internal_for_owner",
            return_value=([], [owner_warning]),
        ),
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "task_stores.task_store.update_json",
            side_effect=lambda db, *, task, payload: setattr(task, "json", payload),
        ),
    ):
        upsert_message_knowledge_bindings(Mock(), task, [context], [], 2)

    assert context.status == "ready"
    assert task.json["spec"]["knowledgeBaseRefs"] == [existing]
    assert (
        "conversation owner cannot access"
        in task.json["spec"]["contextWarnings"][0]["message"]
    )


@pytest.mark.unit
def test_private_external_source_is_not_promoted_when_owner_lacks_access() -> None:
    existing = {
        "provider": "ap",
        "mode": "explicit",
        "id": "shared-source",
    }
    private_ref = {
        "provider": "ap",
        "mode": "explicit",
        "id": "member-private",
    }
    task = _task({"externalKnowledgeRefs": [existing]})
    context = _context(external_ref=private_ref)
    owner_warning = {
        "type": "external_knowledge",
        "reason": "access_denied",
        "provider": "ap",
        "id": "member-private",
        "metadata": {
            "canonicalKey": ("external:ap:explicit:member-private:knowledge_base::")
        },
    }
    dependencies = _service_dependencies(task)
    with (
        dependencies[0],
        dependencies[1],
        dependencies[2],
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "_filter_external_for_owner",
            return_value=([], [owner_warning]),
        ),
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "task_stores.task_store.update_json",
            side_effect=lambda db, *, task, payload: setattr(task, "json", payload),
        ),
    ):
        upsert_message_knowledge_bindings(Mock(), task, [], [context], 2)

    assert context.status == "ready"
    assert task.json["spec"]["externalKnowledgeRefs"] == [existing]
    assert task.json["spec"]["contextWarnings"][0]["id"] == "member-private"


@pytest.mark.unit
def test_missing_owner_does_not_create_binding() -> None:
    task = _task()
    context = _context(knowledge_id=2)
    dependencies = _service_dependencies(task, owner=SimpleNamespace(id=1))
    with (
        dependencies[0],
        dependencies[1],
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=None,
        ),
        patch(
            "app.services.chat.task_knowledge_binding_service."
            "task_stores.task_store.update_json",
            side_effect=lambda db, *, task, payload: setattr(task, "json", payload),
        ),
    ):
        upsert_message_knowledge_bindings(Mock(), task, [context], [], 2)

    assert task.json["spec"].get("knowledgeBaseRefs") is None
    assert task.json["spec"]["contextWarnings"][0]["reason"] == "actor_not_found"


@pytest.mark.unit
def test_sequential_locked_updates_preserve_different_sources() -> None:
    refs, scopes, _ = upsert_internal_knowledge_bindings(
        [], [], [_snapshot(1)], max_knowledge_bases=10
    )
    refs, scopes, _ = upsert_internal_knowledge_bindings(
        refs, scopes, [_snapshot(2)], max_knowledge_bases=10
    )

    assert [ref["id"] for ref in refs] == [1, 2]


@pytest.mark.unit
def test_sequential_same_source_update_uses_last_snapshot() -> None:
    refs = upsert_external_knowledge_refs(
        [],
        [
            {
                "provider": "ap",
                "mode": "explicit",
                "id": "source-a",
                "target_type": "document",
                "document_id": "first",
            }
        ],
    )
    refs = upsert_external_knowledge_refs(
        refs,
        [
            {
                "provider": "ap",
                "mode": "explicit",
                "id": "source-a",
                "target_type": "document",
                "document_id": "last",
            }
        ],
    )

    assert [ref["document_id"] for ref in refs] == ["last"]


class _LockedTaskUpdates:
    def __init__(self) -> None:
        self.task = _task()
        self.row_lock = Lock()
        self.first_locked = Event()
        self.second_started = Event()
        self.errors: list[Exception] = []

    def get_locked_task(self, db, *, task_id):
        self.row_lock.acquire()
        if current_thread().name == "first-update":
            self.first_locked.set()
        return self.task

    def update_task(self, db, *, task, payload):
        if current_thread().name == "first-update":
            self.second_started.wait(timeout=2)
        task.json = payload
        self.row_lock.release()

    def run_update(self, ref: dict) -> None:
        try:
            upsert_message_knowledge_bindings(
                Mock(), self.task, [], [_context(external_ref=ref)], 2
            )
        except Exception as exc:  # pragma: no cover - asserted below
            self.errors.append(exc)

    @staticmethod
    def filter_external(contexts, owner_id):
        return [context.type_data["external_ref"] for context in contexts], []


def _concurrent_update_patches(state: _LockedTaskUpdates) -> list:
    prefix = "app.services.chat.task_knowledge_binding_service."
    return [
        patch(
            f"{prefix}task_stores.task_store.get_by_id_for_update",
            side_effect=state.get_locked_task,
        ),
        patch(
            f"{prefix}_get_active_user",
            return_value=SimpleNamespace(id=2, user_name="sender"),
        ),
        patch(
            f"{prefix}KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=SimpleNamespace(id=2),
        ),
        patch(
            f"{prefix}_filter_external_for_owner",
            side_effect=state.filter_external,
        ),
        patch(
            f"{prefix}task_stores.task_store.update_json",
            side_effect=state.update_task,
        ),
    ]


def _run_concurrent_external_updates(
    first_ref: dict,
    second_ref: dict,
) -> list[dict]:
    state = _LockedTaskUpdates()

    with ExitStack() as stack:
        for dependency in _concurrent_update_patches(state):
            stack.enter_context(dependency)
        first = Thread(target=state.run_update, args=(first_ref,), name="first-update")
        second = Thread(
            target=state.run_update, args=(second_ref,), name="second-update"
        )
        first.start()
        assert state.first_locked.wait(timeout=2)
        second.start()
        state.second_started.set()
        first.join(timeout=2)
        second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert state.errors == []
    return state.task.json["spec"]["externalKnowledgeRefs"]


@pytest.mark.unit
def test_concurrent_updates_preserve_different_external_sources() -> None:
    refs = _run_concurrent_external_updates(
        {"provider": "ap", "mode": "explicit", "id": "source-a"},
        {"provider": "ap", "mode": "explicit", "id": "source-b"},
    )

    assert [ref["id"] for ref in refs] == ["source-a", "source-b"]


@pytest.mark.unit
def test_concurrent_same_source_update_uses_last_committer() -> None:
    refs = _run_concurrent_external_updates(
        {
            "provider": "ap",
            "mode": "explicit",
            "id": "source-a",
            "target_type": "document",
            "document_id": "first",
        },
        {
            "provider": "ap",
            "mode": "explicit",
            "id": "source-a",
            "target_type": "document",
            "document_id": "last",
        },
    )

    assert [ref["document_id"] for ref in refs] == ["last"]
