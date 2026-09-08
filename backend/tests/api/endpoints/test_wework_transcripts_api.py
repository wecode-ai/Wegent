# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib

import zstandard

from app.models.wework_transcript import (
    WeworkTranscript,
    WeworkTranscriptArchive,
    WeworkTranscriptTurn,
)


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _lease(test_client, test_token, transcript_id="transcript-1", client_id="client-a"):
    response = test_client.post(
        f"/api/wework-transcripts/{transcript_id}/lease",
        headers=_headers(test_token),
        json={"clientId": client_id, "ttlSeconds": 60, "title": "Synced chat"},
    )
    assert response.status_code == 200
    return response.json()


def test_appends_and_pulls_finalized_transcript_turns(
    test_client,
    test_token,
):
    lease = _lease(test_client, test_token)

    response = test_client.post(
        "/api/wework-transcripts/transcript-1/turns",
        headers=_headers(test_token),
        json={
            "clientId": "client-a",
            "baseSequence": 0,
            "fencingToken": lease["fencingToken"],
            "turns": [
                {
                    "turnId": "turn-1",
                    "sequence": 1,
                    "payload": {
                        "userMessage": "hello",
                        "assistantMessage": "hi",
                    },
                },
                {
                    "turnId": "turn-2",
                    "sequence": 2,
                    "payload": {
                        "userMessage": "continue",
                        "assistantMessage": "done",
                    },
                },
            ],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"currentSequence": 2, "appended": 2}

    retry = test_client.post(
        "/api/wework-transcripts/transcript-1/turns",
        headers=_headers(test_token),
        json={
            "clientId": "client-a",
            "baseSequence": 0,
            "fencingToken": lease["fencingToken"],
            "turns": [
                {
                    "turnId": "turn-1",
                    "sequence": 1,
                    "payload": {
                        "userMessage": "hello",
                        "assistantMessage": "hi",
                    },
                },
                {
                    "turnId": "turn-2",
                    "sequence": 2,
                    "payload": {
                        "userMessage": "continue",
                        "assistantMessage": "done",
                    },
                },
            ],
        },
    )
    assert retry.status_code == 200
    assert retry.json() == {"currentSequence": 2, "appended": 0}

    response = test_client.get(
        "/api/wework-transcripts/transcript-1/turns?after=1",
        headers=_headers(test_token),
    )

    assert response.status_code == 200
    assert response.json()["currentSequence"] == 2
    assert [turn["turnId"] for turn in response.json()["turns"]] == ["turn-2"]

    transcript = test_client.get(
        "/api/wework-transcripts/transcript-1",
        headers=_headers(test_token),
    )
    assert transcript.status_code == 200
    assert transcript.json()["parentTranscriptId"] is None
    assert transcript.json()["forkedAtSequence"] is None
    assert transcript.json()["archivedAt"] is None


def test_rejects_stale_sequence_and_stale_writer(
    test_client,
    test_token,
):
    lease = _lease(test_client, test_token)
    first = test_client.post(
        "/api/wework-transcripts/transcript-1/turns",
        headers=_headers(test_token),
        json={
            "clientId": "client-a",
            "baseSequence": 0,
            "fencingToken": lease["fencingToken"],
            "turns": [{"turnId": "turn-1", "sequence": 1, "payload": {}}],
        },
    )
    assert first.status_code == 200

    stale_sequence = test_client.post(
        "/api/wework-transcripts/transcript-1/turns",
        headers=_headers(test_token),
        json={
            "clientId": "client-a",
            "baseSequence": 0,
            "fencingToken": lease["fencingToken"],
            "turns": [{"turnId": "turn-2", "sequence": 1, "payload": {}}],
        },
    )
    assert stale_sequence.status_code == 409
    assert stale_sequence.json()["detail"]["code"] == "sequence_conflict"

    other_writer = test_client.post(
        "/api/wework-transcripts/transcript-1/lease",
        headers=_headers(test_token),
        json={"clientId": "client-b", "ttlSeconds": 60},
    )
    assert other_writer.status_code == 409
    assert other_writer.json()["detail"]["code"] == "lease_held"


def test_creates_a_linked_branch_without_copying_parent_turns(
    test_client,
    test_token,
    test_db,
):
    parent_lease = _lease(test_client, test_token)
    parent_append = test_client.post(
        "/api/wework-transcripts/transcript-1/turns",
        headers=_headers(test_token),
        json={
            "clientId": "client-a",
            "baseSequence": 0,
            "fencingToken": parent_lease["fencingToken"],
            "turns": [{"turnId": "parent-turn", "sequence": 1, "payload": {}}],
        },
    )
    assert parent_append.status_code == 200

    branch_lease = test_client.post(
        "/api/wework-transcripts/fork-device-b/lease",
        headers=_headers(test_token),
        json={
            "clientId": "client-b",
            "ttlSeconds": 60,
            "title": "Synced chat",
            "parentTranscriptId": "transcript-1",
            "forkedAtSequence": 1,
        },
    )
    assert branch_lease.status_code == 200
    assert branch_lease.json()["currentSequence"] == 0

    branch_append = test_client.post(
        "/api/wework-transcripts/fork-device-b/turns",
        headers=_headers(test_token),
        json={
            "clientId": "client-b",
            "baseSequence": 0,
            "fencingToken": branch_lease.json()["fencingToken"],
            "turns": [{"turnId": "branch-turn", "sequence": 1, "payload": {}}],
        },
    )
    assert branch_append.status_code == 200

    listing = test_client.get(
        "/api/wework-transcripts",
        headers=_headers(test_token),
    )
    branch = next(
        item
        for item in listing.json()["items"]
        if item["transcriptId"] == "fork-device-b"
    )
    assert branch["parentTranscriptId"] == "transcript-1"
    assert branch["forkedAtSequence"] == 1
    assert test_db.query(WeworkTranscriptTurn).count() == 2
    assert (
        test_db.query(WeworkTranscriptTurn)
        .join(
            WeworkTranscript,
            WeworkTranscript.id == WeworkTranscriptTurn.transcript_db_id,
        )
        .filter(WeworkTranscript.transcript_id == "fork-device-b")
        .one()
        .turn_id
        == "branch-turn"
    )


def test_rejects_an_invalid_or_redefined_branch_identity(
    test_client,
    test_token,
):
    _lease(test_client, test_token)
    missing_fork_point = test_client.post(
        "/api/wework-transcripts/fork-device-b/lease",
        headers=_headers(test_token),
        json={
            "clientId": "client-b",
            "ttlSeconds": 60,
            "parentTranscriptId": "transcript-1",
        },
    )
    assert missing_fork_point.status_code == 422

    missing_parent = test_client.post(
        "/api/wework-transcripts/missing-parent-branch/lease",
        headers=_headers(test_token),
        json={
            "clientId": "client-b",
            "ttlSeconds": 60,
            "parentTranscriptId": "does-not-exist",
            "forkedAtSequence": 0,
        },
    )
    assert missing_parent.status_code == 404
    assert missing_parent.json()["detail"]["code"] == "transcript_not_found"

    branch = test_client.post(
        "/api/wework-transcripts/fork-device-b/lease",
        headers=_headers(test_token),
        json={
            "clientId": "client-b",
            "ttlSeconds": 60,
            "parentTranscriptId": "transcript-1",
            "forkedAtSequence": 0,
        },
    )
    assert branch.status_code == 200
    redefined = test_client.post(
        "/api/wework-transcripts/fork-device-b/lease",
        headers=_headers(test_token),
        json={
            "clientId": "client-b",
            "ttlSeconds": 60,
        },
    )
    assert redefined.status_code == 409
    assert redefined.json()["detail"]["code"] == "fork_identity_conflict"


def test_archives_hot_turns_only_after_object_storage_succeeds(
    test_client,
    test_token,
    test_db,
    monkeypatch,
):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    append = test_client.post(
        "/api/wework-transcripts/transcript-1/turns",
        headers=_headers(test_token),
        json={
            "clientId": "client-a",
            "baseSequence": 0,
            "fencingToken": lease["fencingToken"],
            "turns": [
                {
                    "turnId": "turn-1",
                    "sequence": 1,
                    "payload": {"assistantMessage": "persist me"},
                }
            ],
        },
    )
    assert append.status_code == 200

    stored: dict[str, bytes] = {}

    def put(key: str, content: bytes) -> None:
        stored[key] = content

    monkeypatch.setattr(wework_transcript_service.wework_transcript_storage, "put", put)
    response = test_client.post(
        "/api/wework-transcripts/transcript-1/archive",
        headers=_headers(test_token),
        json={
            "clientId": "client-a",
            "fencingToken": lease["fencingToken"],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["state"] == "archived"
    assert payload["archivedThroughSequence"] == 1
    assert len(payload["archives"]) == 1
    archive = payload["archives"][0]
    assert archive["downloadUrl"] is None
    content = next(iter(stored.values()))
    assert hashlib.sha256(content).hexdigest() == archive["sha256"]
    decoded = zstandard.ZstdDecompressor().decompress(content).decode()
    assert '"turnId":"turn-1"' in decoded
    assert '"persist me"' in decoded

    transcript = test_db.query(WeworkTranscript).one()
    assert transcript.writer_client_id == ""
    assert payload["writerClientId"] is None
    assert payload["writerLeaseExpiresAt"] is None
    assert test_db.query(WeworkTranscriptTurn).count() == 0
    assert test_db.query(WeworkTranscriptArchive).count() == 1

    from app.api.endpoints import wework_transcripts

    monkeypatch.setattr(
        wework_transcripts.wework_transcript_storage,
        "download_url",
        lambda key: f"https://storage.example/{key}",
    )
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "get",
        lambda key: stored[key],
    )
    download = test_client.get(
        f"/api/wework-transcripts/transcript-1/archives/{archive['id']}/download",
        headers=_headers(test_token),
    )
    assert download.status_code == 200
    assert download.json()["downloadUrl"].startswith("https://storage.example/")

    archived_turns = test_client.get(
        f"/api/wework-transcripts/transcript-1/archives/{archive['id']}/turns",
        headers=_headers(test_token),
    )
    assert archived_turns.status_code == 200
    assert archived_turns.json()["turns"][0]["turnId"] == "turn-1"
    assert (
        archived_turns.json()["turns"][0]["payload"]["assistantMessage"] == "persist me"
    )


def test_does_not_delete_hot_turns_when_archive_upload_fails(
    test_client,
    test_token,
    test_db,
    monkeypatch,
):
    from app.services import wework_transcript_service
    from app.services.wework_transcript_storage import WeworkTranscriptStorageError

    lease = _lease(test_client, test_token)
    append = test_client.post(
        "/api/wework-transcripts/transcript-1/turns",
        headers=_headers(test_token),
        json={
            "clientId": "client-a",
            "baseSequence": 0,
            "fencingToken": lease["fencingToken"],
            "turns": [{"turnId": "turn-1", "sequence": 1, "payload": {}}],
        },
    )
    assert append.status_code == 200

    def fail(_key: str, _content: bytes) -> None:
        raise WeworkTranscriptStorageError("storage unavailable")

    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "put",
        fail,
    )

    response = test_client.post(
        "/api/wework-transcripts/transcript-1/archive",
        headers=_headers(test_token),
        json={
            "clientId": "client-a",
            "fencingToken": lease["fencingToken"],
        },
    )

    assert response.status_code == 503
    test_db.rollback()
    assert test_db.query(WeworkTranscriptTurn).count() == 1
    assert test_db.query(WeworkTranscriptArchive).count() == 0
