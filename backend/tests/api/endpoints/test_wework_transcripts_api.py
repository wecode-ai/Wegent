# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import UTC, datetime, timedelta

from app.models.wework_transcript import WeworkTranscript, WeworkTranscriptArchive


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _lease(test_client, token, transcript_id="transcript-1", client_id="client-a"):
    response = test_client.post(
        f"/api/wework-transcripts/{transcript_id}/lease",
        headers=_headers(token),
        json={"clientId": client_id, "ttlSeconds": 60, "title": "Synced chat"},
    )
    assert response.status_code == 200
    return response.json()


def _segment(lease, **overrides):
    return {
        "clientId": "client-a",
        "baseSequence": 0,
        "fencingToken": lease["fencingToken"],
        "title": "Synced chat",
        "sequence": 1,
        "sha256": "a" * 64,
        "sizeBytes": 4096,
        "format": "codex-rollout-snapshot.v1.tgz.aes256gcm",
        **overrides,
    }


def test_commits_only_native_object_metadata(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    encryption = test_client.get(
        "/api/wework-transcripts/transcript-1/encryption-key",
        headers=_headers(test_token),
    )
    assert encryption.status_code == 200
    assert encryption.json()["version"] == 1
    assert encryption.json()["algorithm"] == "aes-256-gcm"
    assert len(encryption.json()["key"]) == 44
    storage = wework_transcript_service.wework_transcript_storage
    monkeypatch.setattr(
        storage,
        "upload_url",
        lambda key: (
            f"https://storage.example/{key}",
            datetime.now(UTC) + timedelta(minutes=5),
        ),
    )
    monkeypatch.setattr(storage, "size", lambda _key: 4096)
    request = _segment(lease)
    prepare = test_client.post(
        "/api/wework-transcripts/transcript-1/segments/prepare",
        headers=_headers(test_token),
        json=request,
    )
    assert prepare.status_code == 200
    assert prepare.json()["uploadUrl"].startswith("https://storage.example/")

    commit = test_client.post(
        "/api/wework-transcripts/transcript-1/segments",
        headers=_headers(test_token),
        json=request,
    )
    assert commit.status_code == 200
    assert commit.json() == {"currentSequence": 1, "appended": 1}
    retry = test_client.post(
        "/api/wework-transcripts/transcript-1/segments",
        headers=_headers(test_token),
        json=request,
    )
    assert retry.json() == {"currentSequence": 1, "appended": 0}

    transcript = test_db.query(WeworkTranscript).one()
    archive = test_db.query(WeworkTranscriptArchive).one()
    assert transcript.current_sequence == 1
    assert transcript.archived_through_sequence == 1
    assert archive.from_sequence == 0
    assert archive.size_bytes == 4096
    assert archive.storage_key.endswith(f"1-snapshot-{'a' * 64}.tgz.aes256gcm")


def test_encryption_keys_are_scoped_to_each_transcript(test_client, test_token):
    _lease(test_client, test_token, transcript_id="transcript-1")
    _lease(test_client, test_token, transcript_id="transcript-2")

    first = test_client.get(
        "/api/wework-transcripts/transcript-1/encryption-key",
        headers=_headers(test_token),
    )
    second = test_client.get(
        "/api/wework-transcripts/transcript-2/encryption-key",
        headers=_headers(test_token),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["key"] != second.json()["key"]


def test_prunes_segments_older_than_previous_snapshot(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    storage = wework_transcript_service.wework_transcript_storage
    deleted_keys: list[str] = []
    monkeypatch.setattr(storage, "size", lambda _key: 4096)
    monkeypatch.setattr(storage, "delete", deleted_keys.append)

    for sequence in range(1, 21):
        is_snapshot = sequence in {1, 10, 20}
        request = _segment(
            lease,
            baseSequence=sequence - 1,
            sequence=sequence,
            sha256=f"{sequence:064x}",
            format=(
                "codex-rollout-snapshot.v1.tgz.aes256gcm"
                if is_snapshot
                else "codex-rollout-delta.v1.tgz.aes256gcm"
            ),
        )
        response = test_client.post(
            "/api/wework-transcripts/transcript-1/segments",
            headers=_headers(test_token),
            json=request,
        )
        assert response.status_code == 200

    retained_sequences = [
        row.to_sequence
        for row in test_db.query(WeworkTranscriptArchive)
        .order_by(WeworkTranscriptArchive.to_sequence)
        .all()
    ]
    assert retained_sequences == list(range(10, 21))
    assert len(deleted_keys) == 9
    assert all(f"/{sequence}-" in key for sequence, key in enumerate(deleted_keys, 1))


def test_rejects_stale_sequence_before_upload(test_client, test_token, monkeypatch):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "size",
        lambda _key: 4096,
    )
    first = test_client.post(
        "/api/wework-transcripts/transcript-1/segments",
        headers=_headers(test_token),
        json=_segment(lease),
    )
    assert first.status_code == 200
    stale = test_client.post(
        "/api/wework-transcripts/transcript-1/segments/prepare",
        headers=_headers(test_token),
        json=_segment(
            lease,
            sha256="b" * 64,
            format="codex-rollout-delta.v1.tgz.aes256gcm",
        ),
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "sequence_conflict"


def test_creates_branch_without_copying_parent_objects(
    test_client, test_token, test_db
):
    _lease(test_client, test_token)
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
    listing = test_client.get(
        "/api/wework-transcripts",
        headers=_headers(test_token),
    )
    item = next(
        row for row in listing.json()["items"] if row["transcriptId"] == "fork-device-b"
    )
    assert item["parentTranscriptId"] == "transcript-1"
    assert item["forkedAtSequence"] == 0
    assert test_db.query(WeworkTranscriptArchive).count() == 0


def test_download_uses_presigned_object_url(
    test_client, test_token, test_db, monkeypatch
):
    from app.api.endpoints import wework_transcripts

    _lease(test_client, test_token)
    transcript = test_db.query(WeworkTranscript).one()
    archive = WeworkTranscriptArchive(
        transcript_db_id=transcript.id,
        from_sequence=0,
        to_sequence=1,
        storage_key="users/1/transcripts/key/1-snapshot.tgz.aes256gcm",
        sha256="c" * 64,
        size_bytes=10,
        format="codex-rollout-snapshot.v1.tgz.aes256gcm",
    )
    test_db.add(archive)
    test_db.commit()
    monkeypatch.setattr(
        wework_transcripts.wework_transcript_storage,
        "download_url",
        lambda key: f"https://storage.example/{key}",
    )
    response = test_client.get(
        f"/api/wework-transcripts/transcript-1/archives/{archive.id}/download",
        headers=_headers(test_token),
    )
    assert response.status_code == 200
    assert response.json()["downloadUrl"].startswith("https://storage.example/")
