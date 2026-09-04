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
    assert transcript.writer_client_id is None
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
