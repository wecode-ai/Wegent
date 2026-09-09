# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import SQLAlchemyError

from app.models.wework_transcript import (
    WeworkTranscript,
    WeworkTranscriptArchive,
    WeworkTranscriptTurn,
)


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
        "format": "codex-snapshot.v1.tgz.aes256gcm",
        "turnId": "turn-1",
        "summary": {
            "userMessages": [{"id": "user-1", "text": "Continue"}],
            "assistantMessage": "Done",
            "reasoning": "Checked",
            "completion": {"kind": "completed"},
            "taskId": "task-1",
        },
        **overrides,
    }


def _segment_integrity(object_key: str, _max_bytes: int) -> tuple[int, str]:
    digest = object_key.rsplit("-", 1)[-1].split(".", 1)[0]
    return 4096, digest


def test_commits_native_object_metadata_and_structured_summary(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    encryption = test_client.get(
        "/api/wework-transcripts/transcript-1/encryption-key",
        headers=_headers(test_token),
    )
    assert encryption.status_code == 200
    assert encryption.json()["algorithm"] == "aes-256-gcm"
    assert len(encryption.json()["key"]) == 44
    storage = wework_transcript_service.wework_transcript_storage
    monkeypatch.setattr(
        storage,
        "upload_policy",
        lambda key, size_bytes: (
            f"https://storage.example/{key}",
            {"key": key, "expected-size": str(size_bytes)},
            datetime.now(UTC) + timedelta(minutes=5),
        ),
    )
    monkeypatch.setattr(storage, "integrity", _segment_integrity)
    request = _segment(lease)
    prepare = test_client.post(
        "/api/wework-transcripts/transcript-1/segments/prepare",
        headers=_headers(test_token),
        json=request,
    )
    assert prepare.status_code == 200
    assert prepare.json()["uploadUrl"].startswith("https://storage.example/")
    assert prepare.json()["uploadFields"]["expected-size"] == "4096"

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
    turn = test_db.query(WeworkTranscriptTurn).one()
    assert transcript.current_sequence == 1
    assert transcript.archived_through_sequence == 1
    assert archive.from_sequence == 0
    assert archive.size_bytes == 4096
    assert archive.storage_key.endswith(f"1-snapshot-{'a' * 64}.tgz.aes256gcm")
    assert turn.sequence == 1
    assert turn.turn_id == "turn-1"
    assert turn.payload["assistantMessage"] == "Done"

    turns = test_client.get(
        "/api/wework-transcripts/transcript-1/turns?after=0&limit=1",
        headers=_headers(test_token),
    )
    assert turns.status_code == 200
    assert turns.json()["currentSequence"] == 1
    assert turns.json()["hasMore"] is False
    assert turns.json()["turns"][0]["payload"]["taskId"] == "task-1"


def test_rejects_uploaded_segment_with_mismatched_digest(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "integrity",
        lambda _key, _max_bytes: (4096, "b" * 64),
    )

    response = test_client.post(
        "/api/wework-transcripts/transcript-1/segments",
        headers=_headers(test_token),
        json=_segment(lease),
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "segment_digest_mismatch"
    assert test_db.query(WeworkTranscriptArchive).count() == 0
    assert test_db.query(WeworkTranscriptTurn).count() == 0
    assert test_db.query(WeworkTranscript).one().current_sequence == 0


def test_encryption_key_is_shared_by_one_user_across_transcripts(
    test_client, test_token
):
    from app.core.wework_transcript_encryption import transcript_encryption_key

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
    assert first.json()["key"] == second.json()["key"]
    assert transcript_encryption_key(1) != transcript_encryption_key(2)


def test_prunes_segments_older_than_previous_snapshot(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    storage = wework_transcript_service.wework_transcript_storage
    deleted_keys: list[str] = []
    monkeypatch.setattr(storage, "integrity", _segment_integrity)
    monkeypatch.setattr(storage, "delete", deleted_keys.append)

    for sequence in range(1, 21):
        is_snapshot = sequence in {1, 10, 20}
        request = _segment(
            lease,
            baseSequence=sequence - 1,
            sequence=sequence,
            sha256=f"{sequence:064x}",
            turnId=f"turn-{sequence}",
            summary={
                "assistantMessage": f"Done {sequence}",
                "taskId": "task-1",
            },
            format=(
                "codex-snapshot.v1.tgz.aes256gcm"
                if is_snapshot
                else "codex-delta.v1.tgz.aes256gcm"
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
    assert test_db.query(WeworkTranscriptTurn).count() == 20
    assert len(deleted_keys) == 9
    assert all(f"/{sequence}-" in key for sequence, key in enumerate(deleted_keys, 1))


def test_continues_bounded_pruning_on_delta_commits(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    storage = wework_transcript_service.wework_transcript_storage
    deleted_keys: list[str] = []
    monkeypatch.setattr(storage, "integrity", _segment_integrity)
    monkeypatch.setattr(storage, "delete", deleted_keys.append)
    monkeypatch.setattr(wework_transcript_service, "MAX_SEGMENTS_PRUNED_PER_COMMIT", 2)

    pruned_per_commit: list[int] = []
    for sequence in range(1, 7):
        is_snapshot = sequence in {1, 4, 5}
        deleted_before_commit = len(deleted_keys)
        response = test_client.post(
            "/api/wework-transcripts/transcript-1/segments",
            headers=_headers(test_token),
            json=_segment(
                lease,
                baseSequence=sequence - 1,
                sequence=sequence,
                sha256=f"{sequence:064x}",
                turnId=f"turn-{sequence}",
                format=(
                    "codex-snapshot.v1.tgz.aes256gcm"
                    if is_snapshot
                    else "codex-delta.v1.tgz.aes256gcm"
                ),
            ),
        )
        assert response.status_code == 200
        pruned_per_commit.append(len(deleted_keys) - deleted_before_commit)

    retained_sequences = [
        row.to_sequence
        for row in test_db.query(WeworkTranscriptArchive)
        .order_by(WeworkTranscriptArchive.to_sequence)
        .all()
    ]
    assert retained_sequences == [4, 5, 6]
    assert len(deleted_keys) == 3
    assert pruned_per_commit == [0, 0, 0, 0, 2, 1]


def test_pruning_hides_obsolete_metadata_and_retries_object_deletion(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service
    from app.services.wework_transcript_storage import WeworkTranscriptStorageError

    lease = _lease(test_client, test_token)
    storage = wework_transcript_service.wework_transcript_storage
    monkeypatch.setattr(storage, "integrity", _segment_integrity)
    failures = 1

    def delete(_key):
        nonlocal failures
        if failures:
            failures -= 1
            raise WeworkTranscriptStorageError("temporary failure")

    monkeypatch.setattr(storage, "delete", delete)
    for sequence in (1, 2, 3):
        response = test_client.post(
            "/api/wework-transcripts/transcript-1/segments",
            headers=_headers(test_token),
            json=_segment(
                lease,
                baseSequence=sequence - 1,
                sequence=sequence,
                sha256=f"{sequence:064x}",
                turnId=f"turn-{sequence}",
                format="codex-snapshot.v1.tgz.aes256gcm",
            ),
        )
        assert response.status_code == 200

    obsolete = (
        test_db.query(WeworkTranscriptArchive)
        .filter(WeworkTranscriptArchive.to_sequence == 1)
        .one()
    )
    listing = test_client.get(
        "/api/wework-transcripts/transcript-1",
        headers=_headers(test_token),
    )
    assert [item["toSequence"] for item in listing.json()["archives"]] == [2, 3]
    download = test_client.get(
        f"/api/wework-transcripts/transcript-1/archives/{obsolete.id}/download",
        headers=_headers(test_token),
    )
    assert download.status_code == 404

    wework_transcript_service._prune_obsolete_segments(
        test_db, obsolete.transcript_db_id
    )
    assert (
        test_db.query(WeworkTranscriptArchive)
        .filter(WeworkTranscriptArchive.to_sequence == 1)
        .count()
        == 0
    )


def test_pruning_hides_metadata_when_database_delete_commit_fails(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service
    from app.services.wework_transcript_storage import WeworkTranscriptStorageError

    lease = _lease(test_client, test_token)
    storage = wework_transcript_service.wework_transcript_storage
    monkeypatch.setattr(storage, "integrity", _segment_integrity)
    monkeypatch.setattr(
        storage,
        "delete",
        lambda _key: (_ for _ in ()).throw(WeworkTranscriptStorageError("defer")),
    )
    for sequence in (1, 2, 3):
        response = test_client.post(
            "/api/wework-transcripts/transcript-1/segments",
            headers=_headers(test_token),
            json=_segment(
                lease,
                baseSequence=sequence - 1,
                sequence=sequence,
                sha256=f"{sequence:064x}",
                turnId=f"turn-{sequence}",
                format="codex-snapshot.v1.tgz.aes256gcm",
            ),
        )
        assert response.status_code == 200

    obsolete = (
        test_db.query(WeworkTranscriptArchive)
        .filter(WeworkTranscriptArchive.to_sequence == 1)
        .one()
    )
    deleted_keys = []
    monkeypatch.setattr(storage, "delete", deleted_keys.append)
    real_commit = test_db.commit
    failures = 1

    def commit():
        nonlocal failures
        if failures:
            failures -= 1
            raise SQLAlchemyError("temporary commit failure")
        real_commit()

    monkeypatch.setattr(test_db, "commit", commit)
    wework_transcript_service._prune_obsolete_segments(
        test_db, obsolete.transcript_db_id
    )

    assert len(deleted_keys) == 1
    assert test_db.query(WeworkTranscriptArchive).filter_by(id=obsolete.id).count() == 1
    listing = test_client.get(
        "/api/wework-transcripts/transcript-1",
        headers=_headers(test_token),
    )
    assert [item["toSequence"] for item in listing.json()["archives"]] == [2, 3]
    download = test_client.get(
        f"/api/wework-transcripts/transcript-1/archives/{obsolete.id}/download",
        headers=_headers(test_token),
    )
    assert download.status_code == 404

    wework_transcript_service._prune_obsolete_segments(
        test_db, obsolete.transcript_db_id
    )
    assert test_db.query(WeworkTranscriptArchive).filter_by(id=obsolete.id).count() == 0


def test_rejects_stale_sequence_before_upload(test_client, test_token, monkeypatch):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "integrity",
        _segment_integrity,
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
            format="codex-delta.v1.tgz.aes256gcm",
        ),
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "sequence_conflict"


def test_rejects_mismatched_summary_for_committed_segment(
    test_client, test_token, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "integrity",
        _segment_integrity,
    )
    request = _segment(lease)
    committed = test_client.post(
        "/api/wework-transcripts/transcript-1/segments",
        headers=_headers(test_token),
        json=request,
    )
    assert committed.status_code == 200

    conflict = test_client.post(
        "/api/wework-transcripts/transcript-1/segments",
        headers=_headers(test_token),
        json={
            **request,
            "summary": {
                **request["summary"],
                "assistantMessage": "Different",
            },
        },
    )

    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "turn_conflict"


def test_reports_turn_conflict_when_turn_identity_exists_at_another_sequence(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_client, test_token)
    transcript = test_db.query(WeworkTranscript).one()
    test_db.add(
        WeworkTranscriptTurn(
            transcript_db_id=transcript.id,
            sequence=9,
            turn_id="turn-1",
            payload={"assistantMessage": "Existing"},
        )
    )
    test_db.commit()
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "integrity",
        _segment_integrity,
    )

    conflict = test_client.post(
        "/api/wework-transcripts/transcript-1/segments",
        headers=_headers(test_token),
        json=_segment(lease),
    )

    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "turn_conflict"


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
    assert test_db.query(WeworkTranscriptTurn).count() == 0


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
        format="codex-snapshot.v1.tgz.aes256gcm",
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
