"""Concurrent HTTP requests, worker reads, OAuth callbacks, and real row locks."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Callable

import pytest

from app.db.session import SessionLocal
from app.models.user import User
from e2e_checks.dingtalk_oauth.support import (
    Actor,
    create_chat_team,
    ok,
    run_chat,
    wait_for_user_lock,
)


def test_expired_grant_is_shared_by_concurrent_imports_and_a_real_task(
    actor: Actor,
) -> None:
    actor.authorize()
    actor.authorize("table")
    table_grant = actor.snapshot("table")
    actor.sync_directory()
    actor.create_knowledge_base()
    team_id = create_chat_team(actor)
    actor.expire()
    gate = actor.provider.gate("refresh", actor.name)
    with ThreadPoolExecutor(max_workers=1) as workers:
        first = actor.import_document("doc")["id"]
        try:
            assert gate.entered.wait(5), "Import worker did not request refresh"
            second = actor.import_document("other")["id"]
            chat = workers.submit(run_chat, actor, team_id)
            wait_for_user_lock(actor, minimum=2)
        finally:
            gate.release.set()
        task_id = chat.result(timeout=90)
    assert task_id > 0
    for node_id, document_id in [("doc", first), ("other", second)]:
        actor.wait_document(
            document_id, marker=actor.provider.marker(actor.name, node_id)
        )
    assert len(actor.events("refresh")) == 1
    actor.assert_stored_grant()
    assert actor.snapshot("table") == table_grant
    access = actor.snapshot()["access"]
    calls = [
        event
        for event in actor.events("tool")
        if event["name"] == "get_document_content"
    ]
    assert len(calls) >= 3
    assert all(event["access"] == access for event in calls)


@pytest.mark.parametrize(
    "revoked", [False, True], ids=["refresh-success", "invalid-grant"]
)
def test_refresh_does_not_cancel_pending_reauthorization(
    actor: Actor, revoked: bool
) -> None:
    actor.authorize()
    actor.authorize("table")
    table_grant = actor.snapshot("table")
    actor.sync_directory()
    actor.create_knowledge_base()
    pending = actor.begin()
    actor.expire(revoke=revoked)
    gate = actor.provider.gate("refresh", actor.name)
    try:
        document_id = actor.import_document()["id"]
        assert gate.entered.wait(5)
        assert pending.poll()["status"] == "pending"
    finally:
        gate.release.set()
    actor.wait_document(document_id, "failed" if revoked else "success")
    assert pending.poll()["status"] == "pending"
    if revoked:
        assert actor.snapshot()["access"] == actor.snapshot()["refresh"] == ""
        assert actor.events("invalid_grant")
        assert not any(
            event["name"] == "get_document_content" for event in actor.events("tool")
        )
    pending.complete()
    assert pending.poll()["status"] == "success"
    actor.assert_stored_grant()
    assert actor.snapshot("table") == table_grant
    if revoked:
        assert actor.import_document()["id"] == document_id
        actor.wait_document(
            document_id, marker=actor.provider.marker(actor.name, "doc")
        )


def test_invalid_grant_blocks_reads_without_borrowing_another_user_or_service(
    actor: Actor, actor_factory: Callable[[], Actor]
) -> None:
    other = actor_factory()
    other.authorize()
    other_grant = other.snapshot()
    actor.authorize()
    actor.authorize("table")
    table_grant = actor.snapshot("table")
    actor.sync_directory()
    actor.create_knowledge_base()
    before = len(actor.events("mcp"))
    actor.expire(revoke=True)
    document_id = actor.import_document()["id"]
    failed = actor.wait_document(document_id, "failed")
    assert failed["is_active"] is False
    assert failed["processing_error"]["code"] == "dingtalk_authorization_required"
    assert actor.snapshot()["access"] == actor.snapshot()["refresh"] == ""
    assert len(actor.events("mcp")) == before
    assert actor.content(document_id) == ""
    actor.sync_directory(status=400)
    assert other.snapshot() == other_grant
    assert actor.snapshot("table") == table_grant
    # The other user's real read remains functional, not just its stored token.
    other.sync_directory()


@pytest.mark.parametrize("operation", ["disconnect", "save", "replace"])
def test_late_callback_cannot_restore_or_replace_credentials(
    actor: Actor, operation: str
) -> None:
    actor.authorize()
    actor.sync_directory()
    actor.create_knowledge_base()
    late = actor.begin()
    gate = actor.provider.gate("exchange", actor.name)
    with ThreadPoolExecutor(max_workers=1) as workers:
        callback = workers.submit(late.complete, 409)
        try:
            assert gate.entered.wait(5), "Callback did not reach token exchange"
            if operation == "disconnect":
                ok(
                    actor.client.delete(
                        actor.service_path("docs") + "/oauth/connection"
                    ),
                    204,
                )
            elif operation == "save":
                actor.configure(suffix="?configuration=changed")
                actor.configure()  # A -> B -> A must not reactivate the old session.
            else:
                # Only the old exchange is paused; the replacement must finish first.
                del actor.provider.gates["exchange", actor.name]
                replacement = actor.begin()
                replacement.complete()
                assert replacement.poll()["status"] == "success"
            expected = actor.snapshot()
        finally:
            gate.release.set()
        callback.result(timeout=15)
    assert late.poll()["status"] == "failed"
    assert actor.snapshot() == expected
    document_id = actor.import_document()["id"]
    if operation == "replace":
        actor.wait_document(
            document_id, marker=actor.provider.marker(actor.name, "doc")
        )
    else:
        assert expected["access"] == expected["refresh"] == ""
        failed = actor.wait_document(document_id, "failed")
        assert failed["is_active"] is False
        assert actor.content(document_id) == ""
        # A conflict is recoverable through a new authorization, never the old code.
        actor.authorize()
        assert actor.import_document()["id"] == document_id
        actor.wait_document(
            document_id, marker=actor.provider.marker(actor.name, "doc")
        )


def test_row_lock_busy_returns_retryable_error_and_preserves_final_state(
    actor: Actor,
) -> None:
    actor.authorize()
    actor.sync_directory()
    actor.create_knowledge_base()
    expected = actor.snapshot()
    with SessionLocal.begin() as lock:
        lock.query(User).filter(User.id == actor.id).with_for_update().one()
        response = actor.sync_directory(status=503)
        assert "retry" in response.json()["detail"].lower()
        assert actor.snapshot() == expected
    actor.sync_directory()
    document_id = actor.import_document()["id"]
    actor.wait_document(document_id, marker=actor.provider.marker(actor.name, "doc"))
    assert actor.snapshot() == expected


def test_two_services_refresh_without_losing_each_others_rotated_grant(
    actor: Actor,
) -> None:
    actor.authorize()
    actor.authorize("table")
    actor.sync_directory()
    actor.create_knowledge_base()
    actor.expire()
    actor.expire("table")
    gate = actor.provider.gate("refresh", actor.name)
    try:
        first = actor.import_document("doc")["id"]
        assert gate.entered.wait(5)
        second = actor.import_document("sheet")["id"]
        wait_for_user_lock(actor)
    finally:
        gate.release.set()
    for node_id, document_id in [("doc", first), ("sheet", second)]:
        actor.wait_document(
            document_id, marker=actor.provider.marker(actor.name, node_id)
        )
    assert sorted(event["service"] for event in actor.events("refresh")) == [
        "docs",
        "table",
    ]
    actor.assert_stored_grant()
    actor.assert_stored_grant("table")


def test_callback_lock_busy_preserves_credentials_and_new_authorization_recovers(
    actor: Actor,
) -> None:
    actor.authorize()
    pending = actor.begin()
    expected = actor.snapshot()
    with SessionLocal.begin() as lock:
        lock.query(User).filter(User.id == actor.id).with_for_update().one()
        response = pending.complete(503)
        assert "retry" in response.json()["detail"].lower()
        assert actor.snapshot() == expected
    assert pending.poll()["status"] == "failed"
    # The exchanged authorization code is single-use; recovery starts a new flow.
    replacement = actor.begin()
    replacement.complete()
    assert replacement.poll()["status"] == "success"
    actor.assert_stored_grant()
    actor.sync_directory()
