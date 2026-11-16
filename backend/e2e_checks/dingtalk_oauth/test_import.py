"""Authorization, import, export download, and queued automatic refresh."""

from __future__ import annotations

import secrets

import pytest

from app.core.celery_app import celery_app
from e2e_checks.dingtalk_oauth.provider import fingerprint
from e2e_checks.dingtalk_oauth.support import Actor, ok, wait_until


def test_oauth_docs_import_and_automatic_sync(actor: Actor) -> None:
    actor.authorize()
    actor.assert_stored_grant()
    actor.sync_directory()
    kb_id = actor.create_knowledge_base()
    document_id = actor.import_document()["id"]
    before = actor.wait_document(
        document_id, marker=actor.provider.marker(actor.name, "doc")
    )
    assert before["external_provider"] == "dingtalk"
    ok(
        actor.client.put(
            f"/api/knowledge-bases/{kb_id}", json={"dingtalk_auto_sync_enabled": True}
        )
    )
    actor.provider.versions[actor.name] = 2
    queued = ok(actor.client.post(f"/api/knowledge-bases/{kb_id}/dingtalk-sync"), 202)
    result = celery_app.AsyncResult(queued["task_id"])
    wait_until(result.ready, "real Celery scan completes")
    assert result.get(timeout=1) == 1
    after = actor.wait_document(
        document_id, marker=actor.provider.marker(actor.name, "doc")
    )
    assert after["index_generation"] > before["index_generation"]
    assert after["source_config"]["external"]["source_update_time"] == 1800000002
    assert actor.provider.marker(actor.name, "doc").replace(
        "V2", "V1"
    ) not in actor.content(document_id)
    actor.assert_stored_grant()
    assert all(event["accepted"] for event in actor.events("mcp"))


@pytest.mark.parametrize("service,node_id", [("table", "sheet"), ("ai_table", "base")])
def test_each_spreadsheet_requires_its_own_grant_and_download_never_gets_mcp_token(
    actor: Actor, service: str, node_id: str
) -> None:
    actor.authorize()
    # Having the other spreadsheet's valid grant must not authorize this one.
    other_service = "ai_table" if service == "table" else "table"
    actor.authorize(other_service)
    other_grant = actor.snapshot(other_service)
    actor.configure(service)
    actor.sync_directory()
    actor.create_knowledge_base()
    document_id = actor.import_document(node_id)["id"]
    failed = actor.wait_document(document_id, "failed")
    assert failed["is_active"] is False
    assert failed["processing_error"]["retryable"] is True
    assert not [event for event in actor.events("tool") if event["service"] == service]
    assert actor.content(document_id) == ""

    actor.authorize(service)
    assert actor.import_document(node_id)["id"] == document_id
    actor.wait_document(document_id, marker=actor.provider.marker(actor.name, node_id))
    actor.assert_stored_grant(service)
    assert actor.snapshot(other_service) == other_grant
    expected_access = actor.snapshot(service)["access"]
    export_calls = [
        event for event in actor.events("tool") if event["service"] == service
    ]
    assert export_calls and all(
        event["access"] == expected_access for event in export_calls
    )
    downloads = actor.events("download")
    assert len(downloads) == 1
    assert downloads[0]["service"] == service
    assert downloads[0]["leaked"] is False
    assert downloads[0]["authorization"] is False


def test_personal_url_mode_still_imports_without_oauth(actor: Actor) -> None:
    actor.authorize()
    personal = secrets.token_urlsafe(24)
    actor.provider.personal[actor.name] = personal
    actor.configure(mode="url", suffix=f"?personal={personal}")
    assert actor.snapshot()["access"] == actor.snapshot()["refresh"] == ""
    refreshes = len(actor.events("refresh"))
    actor.sync_directory()
    actor.create_knowledge_base()
    document_id = actor.import_document()["id"]
    actor.wait_document(document_id, marker=actor.provider.marker(actor.name, "doc"))
    assert len(actor.events("refresh")) == refreshes
    calls = actor.events("tool")
    assert calls and all(event["access"] == fingerprint("") for event in calls)
