"""Node import through the real MCP transport and existing OAuth service suite."""

from __future__ import annotations

import asyncio
import json

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from app.core.celery_app import celery_app
from app.db.session import SessionLocal
from app.models.dingtalk_doc import DingtalkSyncedNode
from app.services.auth import create_task_token
from e2e_checks.dingtalk_oauth.support import Actor, ok, wait_until
from tests.e2e.knowledge_remote_index_support import BACKEND_URL


async def import_node(actor: Actor) -> dict:
    token = create_task_token(0, 0, actor.id, actor.name)
    async with streamablehttp_client(
        BACKEND_URL + "/mcp/knowledge/sse",
        headers={"Authorization": f"Bearer {token}"},
    ) as (reader, writer, _):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            result = await session.call_tool(
                "wegent_kb_import_dingtalk_document",
                {"knowledge_base_id": actor.knowledge_base_id, "node_id": "doc"},
            )
            assert not result.isError
            payload = json.loads(result.content[0].text)
            assert "error" not in payload
            actor.document_ids.add(payload["id"])
            return payload


def test_unsynced_mcp_copy_indexes_reimports_and_refreshes_daily(actor: Actor) -> None:
    actor.authorize()
    kb_id = actor.create_knowledge_base()

    created = asyncio.run(import_node(actor))

    document_id = created["id"]
    assert created["action"] == "created"
    assert created["dingtalk_auto_sync_enabled"] is False
    actor.wait_document(document_id, marker=actor.provider.marker(actor.name, "doc"))
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
    with SessionLocal() as db:
        assert (
            db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.user_id == actor.id)
            .count()
        ) == 0
