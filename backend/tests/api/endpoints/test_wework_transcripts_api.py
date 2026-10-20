# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import json

from sqlalchemy.exc import SQLAlchemyError

from app.api.endpoints.wework_transcripts import _lease_response
from app.models.user import User
from app.models.wework_transcript import (
    WeworkTranscript,
    WeworkTranscriptArchive,
    WeworkTranscriptTurn,
)
from app.schemas.wework_transcript import TranscriptLeaseRequest
from app.services import wework_transcript_service

SEGMENT_BODY = b"x" * 4096
SEGMENT_SHA256 = hashlib.sha256(SEGMENT_BODY).hexdigest()


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _lease(test_db, transcript_id="transcript-1", client_id="client-a"):
    user = test_db.query(User).filter(User.user_name == "testuser").one()
    transcript = wework_transcript_service.acquire_lease(
        test_db,
        user_id=user.id,
        transcript_id=transcript_id,
        request=TranscriptLeaseRequest(
            clientId=client_id,
            ttlSeconds=60,
            title="Synced chat",
        ),
    )
    return _lease_response(transcript).model_dump(by_alias=True, mode="json")


def _segment(lease, **overrides):
    return {
        "clientId": "client-a",
        "baseSequence": 0,
        "fencingToken": lease["fencingToken"],
        "title": "Synced chat",
        "sequence": 1,
        "sha256": SEGMENT_SHA256,
        "sizeBytes": len(SEGMENT_BODY),
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


def _upload(
    test_client,
    token,
    request,
    content: bytes = SEGMENT_BODY,
    *,
    normalize_manifest: bool = True,
):
    metadata = dict(request)
    if normalize_manifest:
        metadata["sha256"] = hashlib.sha256(content).hexdigest()
        metadata["sizeBytes"] = len(content)
    return test_client.post(
        "/api/wework-transcripts/transcript-1/segments",
        headers=_headers(token),
        data={"metadata": json.dumps(metadata)},
        files={"file": ("segment.tgz.aes256gcm", content)},
    )


def test_rejects_uploaded_segment_with_mismatched_digest(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_db)
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "put_stream",
        lambda *_args: None,
    )

    response = _upload(
        test_client,
        test_token,
        _segment(lease, sha256="b" * 64),
        normalize_manifest=False,
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "segment_digest_mismatch"
    assert test_db.query(WeworkTranscriptArchive).count() == 0
    assert test_db.query(WeworkTranscriptTurn).count() == 0
    assert test_db.query(WeworkTranscript).one().current_sequence == 0


def test_prunes_segments_older_than_previous_snapshot(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_db)
    storage = wework_transcript_service.wework_transcript_storage
    deleted_keys: list[str] = []
    stored_keys: set[str] = set()
    monkeypatch.setattr(storage, "put_stream", lambda key, *_args: stored_keys.add(key))
    monkeypatch.setattr(storage, "exists", stored_keys.__contains__)

    def delete(key: str) -> None:
        deleted_keys.append(key)
        stored_keys.discard(key)

    monkeypatch.setattr(storage, "delete", delete)

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
        response = _upload(test_client, test_token, request)
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

    lease = _lease(test_db)
    storage = wework_transcript_service.wework_transcript_storage
    deleted_keys: list[str] = []
    stored_keys: set[str] = set()
    monkeypatch.setattr(storage, "put_stream", lambda key, *_args: stored_keys.add(key))
    monkeypatch.setattr(storage, "exists", stored_keys.__contains__)

    def delete(key: str) -> None:
        deleted_keys.append(key)
        stored_keys.discard(key)

    monkeypatch.setattr(storage, "delete", delete)
    monkeypatch.setattr(wework_transcript_service, "MAX_SEGMENTS_PRUNED_PER_COMMIT", 2)

    pruned_per_commit: list[int] = []
    for sequence in range(1, 7):
        is_snapshot = sequence in {1, 4, 5}
        deleted_before_commit = len(deleted_keys)
        response = _upload(
            test_client,
            test_token,
            _segment(
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

    lease = _lease(test_db)
    storage = wework_transcript_service.wework_transcript_storage
    monkeypatch.setattr(storage, "put_stream", lambda *_args: None)
    failures = 1

    def delete(_key):
        nonlocal failures
        if failures:
            failures -= 1
            raise WeworkTranscriptStorageError("temporary failure")

    monkeypatch.setattr(storage, "delete", delete)
    for sequence in (1, 2, 3):
        response = _upload(
            test_client,
            test_token,
            _segment(
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

    lease = _lease(test_db)
    storage = wework_transcript_service.wework_transcript_storage
    monkeypatch.setattr(storage, "put_stream", lambda *_args: None)
    monkeypatch.setattr(
        storage,
        "delete",
        lambda _key: (_ for _ in ()).throw(WeworkTranscriptStorageError("defer")),
    )
    for sequence in (1, 2, 3):
        response = _upload(
            test_client,
            test_token,
            _segment(
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


def test_reports_object_storage_failure_with_a_stable_code(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service
    from app.services.wework_transcript_storage import WeworkTranscriptStorageError

    lease = _lease(test_db)
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "put_stream",
        lambda *_args: (_ for _ in ()).throw(
            WeworkTranscriptStorageError(
                "Failed to store transcript segment (AccessDenied)"
            )
        ),
    )

    response = _upload(test_client, test_token, _segment(lease))

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "transcript_storage_unavailable",
        "message": "Failed to store transcript segment (AccessDenied)",
    }


def test_requires_snapshot_when_the_committed_recovery_chain_is_missing(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_db)
    storage = wework_transcript_service.wework_transcript_storage
    stored_keys = set()

    def put_stream(key, _stream, _size):
        stored_keys.add(key)

    monkeypatch.setattr(storage, "put_stream", put_stream)
    monkeypatch.setattr(storage, "exists", stored_keys.__contains__)

    first = _upload(test_client, test_token, _segment(lease))
    assert first.status_code == 200
    stored_keys.clear()

    delta = _upload(
        test_client,
        test_token,
        _segment(
            lease,
            baseSequence=1,
            sequence=2,
            sha256="2" * 64,
            turnId="turn-2",
            format="codex-delta.v1.tgz.aes256gcm",
        ),
    )
    assert delta.status_code == 409
    assert delta.json()["detail"]["code"] == "snapshot_required"

    snapshot = _upload(
        test_client,
        test_token,
        _segment(
            lease,
            baseSequence=1,
            sequence=2,
            sha256="2" * 64,
            turnId="turn-2",
            format="codex-snapshot.v1.tgz.aes256gcm",
        ),
    )
    assert snapshot.status_code == 200
    assert snapshot.json() == {"currentSequence": 2, "appended": 1}


def test_rejects_conflicting_segment_before_object_storage(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_db)
    uploads = []
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "put_stream",
        lambda *args: uploads.append(args),
    )
    first = _upload(test_client, test_token, _segment(lease))
    assert first.status_code == 200
    assert len(uploads) == 1
    stale = _upload(
        test_client,
        test_token,
        _segment(
            lease,
            sha256="b" * 64,
            format="codex-delta.v1.tgz.aes256gcm",
        ),
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "segment_conflict"
    assert len(uploads) == 1


def test_rejects_mismatched_summary_for_committed_segment(
    test_client, test_token, test_db, monkeypatch
):
    from app.services import wework_transcript_service

    lease = _lease(test_db)
    monkeypatch.setattr(
        wework_transcript_service.wework_transcript_storage,
        "put_stream",
        lambda *_args: None,
    )
    request = _segment(lease)
    committed = _upload(test_client, test_token, request)
    assert committed.status_code == 200

    conflict = _upload(
        test_client,
        test_token,
        {
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

    lease = _lease(test_db)
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
        "put_stream",
        lambda *_args: None,
    )

    conflict = _upload(test_client, test_token, _segment(lease))

    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "turn_conflict"


def test_download_streams_the_object_through_backend(
    test_client, test_token, test_db, monkeypatch
):
    from app.api.endpoints import wework_transcripts

    _lease(test_db)
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
        "stream",
        lambda _key: iter([b"encrypted", b"!!"]),
    )
    response = test_client.get(
        f"/api/wework-transcripts/transcript-1/archives/{archive.id}/download",
        headers=_headers(test_token),
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-length"] == "10"
    assert response.content == b"encrypted!!"


def test_download_reports_a_missing_storage_object_as_not_found(
    test_client, test_token, test_db, monkeypatch
):
    from app.api.endpoints import wework_transcripts
    from app.services.wework_transcript_storage import (
        WeworkTranscriptStorageNotFoundError,
    )

    _lease(test_db)
    transcript = test_db.query(WeworkTranscript).one()
    archive = WeworkTranscriptArchive(
        transcript_db_id=transcript.id,
        from_sequence=0,
        to_sequence=1,
        storage_key="users/1/transcripts/key/missing.tgz.aes256gcm",
        sha256="c" * 64,
        size_bytes=10,
        format="codex-snapshot.v1.tgz.aes256gcm",
    )
    test_db.add(archive)
    test_db.commit()
    monkeypatch.setattr(
        wework_transcripts.wework_transcript_storage,
        "stream",
        lambda _key: (_ for _ in ()).throw(
            WeworkTranscriptStorageNotFoundError("Wework transcript segment not found")
        ),
    )

    response = test_client.get(
        f"/api/wework-transcripts/transcript-1/archives/{archive.id}/download",
        headers=_headers(test_token),
    )

    assert response.status_code == 404
    assert response.json()["detail"] == {
        "code": "archive_not_found",
        "message": "Wework transcript segment not found",
    }
