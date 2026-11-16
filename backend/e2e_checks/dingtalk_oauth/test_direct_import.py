"""Node-import protocol integration; real DingTalk compatibility is unverified."""

from __future__ import annotations

import asyncio
from typing import Callable

import pytest

from app.core.celery_app import celery_app
from app.db.session import SessionLocal
from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.subtask_context import SubtaskContext
from e2e_checks.dingtalk_oauth.broker_probe import ImportDispatchProbe
from e2e_checks.dingtalk_oauth.support import (
    Actor,
    call_knowledge_tool,
    ok,
    wait_until,
)


async def request_import(
    actor: Actor,
    knowledge_base_id: int | None,
    node_id: str = "doc",
    folder_id: int = 0,
) -> dict:
    assert knowledge_base_id is not None, "Create the target knowledge base first"
    return await call_knowledge_tool(
        actor,
        "wegent_kb_import_dingtalk_document",
        {
            "knowledge_base_id": knowledge_base_id,
            "node_id": node_id,
            "folder_id": folder_id,
        },
    )


async def import_node(actor: Actor, folder_id: int = 0) -> dict:
    payload = await request_import(actor, actor.knowledge_base_id, folder_id=folder_id)
    assert "error" not in payload
    actor.document_ids.add(payload["id"])
    return payload


def assert_searchable(actor: Actor, document_id: int) -> None:
    marker = actor.provider.marker(actor.name, "doc")
    result = asyncio.run(
        call_knowledge_tool(
            actor,
            "wegent_kb_search_knowledge_base",
            {
                "knowledge_base_id": actor.knowledge_base_id,
                "query": marker,
                "document_ids": [document_id],
            },
        )
    )
    assert "error" not in result
    assert any(
        chunk["document_id"] == document_id
        and chunk["knowledge_base_id"] == actor.knowledge_base_id
        and marker in chunk["content"]
        for chunk in result["chunks"]
    ), "Imported content was not returned by the Knowledge MCP search"


def assert_no_directory(*actors: Actor) -> None:
    with SessionLocal() as db:
        assert (
            db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.user_id.in_([actor.id for actor in actors]))
            .count()
            == 0
        )
    for actor in actors:
        assert not any(event["name"] == "list_nodes" for event in actor.events("tool"))


def create_shared_copy(owner: Actor, member: Actor, role: str) -> dict:
    owner.authorize()
    member.authorize()
    kb_id = owner.create_knowledge_base()
    ok(
        owner.client.post(
            f"/api/share/KnowledgeBase/{kb_id}/members",
            json={"user_id": member.id, "role": role},
        )
    )
    folder = ok(
        owner.client.post(
            f"/api/knowledge-bases/{kb_id}/folders", json={"name": "Original folder"}
        ),
        201,
    )
    created = asyncio.run(import_node(owner, folder["id"]))
    return owner.wait_document(
        created["id"], marker=owner.provider.marker(owner.name, "doc")
    )


def library_state(owner: Actor, member: Actor) -> dict:
    documents = asyncio.run(
        call_knowledge_tool(
            owner,
            "wegent_kb_list_documents",
            {"knowledge_base_id": owner.knowledge_base_id},
        )
    )
    assert "error" not in documents
    assert documents["total"] == len(documents["items"])
    with SessionLocal() as db:
        attachments = (
            db.query(SubtaskContext.id)
            .filter(SubtaskContext.user_id.in_([owner.id, member.id]))
            .order_by(SubtaskContext.id)
            .all()
        )
    kb = ok(owner.client.get(f"/api/knowledge-bases/{owner.knowledge_base_id}"))
    return {
        "documents": documents["items"],
        "attachments": [row[0] for row in attachments],
        "auto_sync": kb["dingtalk_auto_sync_enabled"],
    }


def test_unsynced_mcp_copy_indexes_reimports_and_refreshes_daily(actor: Actor) -> None:
    actor.authorize()
    kb_id = actor.create_knowledge_base()

    created = asyncio.run(import_node(actor))

    document_id = created["id"]
    assert created["action"] == "created"
    assert created["dingtalk_auto_sync_enabled"] is False
    actor.wait_document(document_id, marker=actor.provider.marker(actor.name, "doc"))
    assert_searchable(actor, document_id)
    refreshed = asyncio.run(import_node(actor))
    assert refreshed["id"] == document_id
    assert refreshed["action"] == "refreshed"
    before = actor.wait_document(
        document_id, marker=actor.provider.marker(actor.name, "doc")
    )
    ok(
        actor.client.put(
            f"/api/knowledge-bases/{kb_id}", json={"dingtalk_auto_sync_enabled": True}
        )
    )
    actor.provider.versions[actor.name] = 2
    queued = ok(actor.client.post(f"/api/knowledge-bases/{kb_id}/dingtalk-sync"), 202)
    task = celery_app.AsyncResult(queued["task_id"])
    wait_until(task.ready, "real Celery scan completes")
    assert task.get(timeout=1) == 1
    after = actor.wait_document(
        document_id, marker=actor.provider.marker(actor.name, "doc")
    )
    assert after["index_generation"] > before["index_generation"]
    assert after["source_config"]["external"]["source_update_time"] == 1800000002
    assert_searchable(actor, document_id)
    assert_no_directory(actor)


def test_manager_refresh_keeps_identity_folder_and_original_oauth(
    actor: Actor, actor_factory: Callable[[], Actor]
) -> None:
    manager = actor_factory()
    before = create_shared_copy(actor, manager, "Maintainer")
    manager_grant = manager.snapshot()
    manager_reads = len(manager.events("mcp"))
    original_reads = len(actor.events("tool"))
    actor.expire()
    actor.provider.versions[actor.name] = 2
    actor.provider.versions[manager.name] = 99

    refreshed = asyncio.run(request_import(manager, actor.knowledge_base_id))

    assert "error" not in refreshed
    assert refreshed["action"] == "refreshed"
    assert refreshed["id"] == before["id"]
    assert refreshed["dingtalk_auto_sync_enabled"] is False
    after = actor.wait_document(
        before["id"], marker=actor.provider.marker(actor.name, "doc")
    )
    assert (after["id"], after["folder_id"], after["user_id"]) == (
        before["id"],
        before["folder_id"],
        actor.id,
    )
    assert after["folder_id"] != 0
    assert after["index_generation"] > before["index_generation"]
    assert actor.provider.marker(manager.name, "doc") not in actor.content(before["id"])
    actor.assert_stored_grant()
    assert len(actor.events("refresh")) == 1
    assert manager.snapshot() == manager_grant
    assert manager.events("mcp")[manager_reads:] == []
    source_reads = actor.events("tool")[original_reads:]
    assert source_reads and all(
        event["access"] == actor.snapshot()["access"] for event in source_reads
    )
    assert_searchable(actor, before["id"])
    assert_no_directory(actor, manager)


def test_processing_node_does_not_publish_another_import(actor: Actor) -> None:
    actor.authorize()
    actor.create_knowledge_base()
    gate = actor.provider.gate("get_document_content", actor.name, timeout=60)
    with ImportDispatchProbe(celery_app.conf.broker_url) as broker:
        try:
            created = asyncio.run(import_node(actor))
            assert gate.entered.wait(10), "Worker did not reach the external body gate"
            before = actor.document(created["id"])
            first_dispatches = [
                record
                for record in broker.drain()
                if record.document_id == created["id"]
            ]
            assert len(first_dispatches) == 1
            for _ in range(2):
                repeated = asyncio.run(import_node(actor))
                assert repeated["id"] == created["id"]
                assert repeated["action"] == "processing"
            after = actor.document(created["id"])
            assert after["index_generation"] == before["index_generation"]
            assert after["attachment_id"] == before["attachment_id"]
            assert [
                record
                for record in broker.drain()
                if record.document_id == created["id"]
            ] == first_dispatches
        finally:
            gate.release.set()
    actor.wait_document(created["id"], marker=actor.provider.marker(actor.name, "doc"))
    assert (
        len(
            [
                event
                for event in actor.events("tool")
                if event["name"] == "get_document_content"
            ]
        )
        == 1
    )
    assert_no_directory(actor)


def test_read_only_member_cannot_import_or_refresh(
    actor: Actor, actor_factory: Callable[[], Actor]
) -> None:
    reader = actor_factory()
    create_shared_copy(actor, reader, "Reporter")
    before = library_state(actor, reader)
    grants = actor.snapshot(), reader.snapshot()
    reads = len(actor.events("mcp")), len(reader.events("mcp"))
    # Confirm the member can read this KB, so rejection is a write-permission boundary.
    visible = asyncio.run(
        call_knowledge_tool(
            reader,
            "wegent_kb_list_documents",
            {"knowledge_base_id": actor.knowledge_base_id},
        )
    )
    assert "error" not in visible and visible["total"] == 1
    with ImportDispatchProbe(celery_app.conf.broker_url) as broker:
        for node_id in ("other", "doc"):
            denied = asyncio.run(
                request_import(reader, actor.knowledge_base_id, node_id)
            )
            assert "permission" in denied["error"].lower()
        assert broker.drain() == []
    assert library_state(actor, reader) == before
    assert (actor.snapshot(), reader.snapshot()) == grants
    assert (len(actor.events("mcp")), len(reader.events("mcp"))) == reads
    assert_no_directory(actor, reader)


@pytest.mark.parametrize("failure", ["source-denied", "invalid-grant"])
def test_source_failure_never_writes_a_copy_or_borrows_credentials(
    actor: Actor, actor_factory: Callable[[], Actor], failure: str
) -> None:
    manager = actor_factory()
    create_shared_copy(actor, manager, "Maintainer")
    actor.authorize("table")
    before = library_state(actor, manager)
    manager_grant, table_grant = manager.snapshot(), actor.snapshot("table")
    original_grant = actor.snapshot()
    owner_reads = len(actor.events("tool"))
    owner_mcp, manager_mcp = len(actor.events("mcp")), len(manager.events("mcp"))
    if failure == "source-denied":
        actor.provider.denied_nodes.update({(actor.name, "doc"), (actor.name, "other")})
    else:
        actor.expire(revoke=True)
    with ImportDispatchProbe(celery_app.conf.broker_url) as broker:
        fresh = asyncio.run(request_import(actor, actor.knowledge_base_id, "other"))
        existing = asyncio.run(request_import(manager, actor.knowledge_base_id))
        assert fresh["error"] and existing["error"]
        assert broker.drain() == []
    assert library_state(actor, manager) == before
    assert manager.snapshot() == manager_grant
    assert actor.snapshot("table") == table_grant
    assert manager.events("mcp")[manager_mcp:] == []
    source_reads = actor.events("tool")[owner_reads:]
    if failure == "source-denied":
        assert actor.snapshot() == original_grant
        assert {event["node_id"] for event in source_reads} == {"doc", "other"}
        assert all(
            event["accepted"] and event["access"] == original_grant["access"]
            for event in actor.events("mcp")[owner_mcp:]
        )
        assert all(
            event["name"] == "get_document_info"
            and event["access"] == original_grant["access"]
            for event in source_reads
        )
    else:
        assert actor.snapshot()["access"] == actor.snapshot()["refresh"] == ""
        assert actor.events("invalid_grant")
        assert source_reads == []
        assert actor.events("mcp")[owner_mcp:] == []
    assert_no_directory(actor, manager)
