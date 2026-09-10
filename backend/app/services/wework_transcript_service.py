# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Synchronization metadata for native Wework transcript segments."""

import hashlib
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.models.wework_transcript import (
    EPOCH_TIME,
    WeworkTranscript,
    WeworkTranscriptArchive,
    WeworkTranscriptTurn,
)
from app.schemas.wework_transcript import (
    TranscriptArchiveRequest,
    TranscriptLeaseReleaseRequest,
    TranscriptLeaseRequest,
    TranscriptSegmentCommitRequest,
    TranscriptSegmentRequest,
)
from app.services.wework_transcript_storage import (
    WeworkTranscriptStorageError,
    wework_transcript_storage,
)

logger = logging.getLogger(__name__)
MAX_SEGMENTS_PRUNED_PER_COMMIT = 20


class WeworkTranscriptError(RuntimeError):
    """Stable transcript synchronization failure."""

    def __init__(self, code: str, message: str, *, status_code: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def list_transcripts(
    db: Session,
    *,
    user_id: int,
    include_archived: bool,
) -> list[WeworkTranscript]:
    query = db.query(WeworkTranscript).filter(WeworkTranscript.user_id == user_id)
    if not include_archived:
        query = query.filter(WeworkTranscript.state == "active")
    return query.order_by(WeworkTranscript.updated_at.desc()).all()


def get_transcript(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    for_update: bool = False,
) -> WeworkTranscript:
    query = db.query(WeworkTranscript).filter(
        WeworkTranscript.user_id == user_id,
        WeworkTranscript.transcript_id == transcript_id,
    )
    if for_update:
        query = query.with_for_update()
    transcript = query.first()
    if transcript is None:
        raise WeworkTranscriptError(
            "transcript_not_found",
            "Wework transcript not found",
            status_code=404,
        )
    return transcript


def acquire_lease(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    request: TranscriptLeaseRequest,
) -> WeworkTranscript:
    _validate_fork_request(request)
    parent_transcript_id = request.parent_transcript_id or ""
    forked_at_sequence = request.forked_at_sequence or 0
    transcript = (
        db.query(WeworkTranscript)
        .filter(
            WeworkTranscript.user_id == user_id,
            WeworkTranscript.transcript_id == transcript_id,
        )
        .with_for_update()
        .first()
    )
    now = utcnow()
    if transcript is None:
        if request.parent_transcript_id is not None:
            parent = get_transcript(
                db,
                user_id=user_id,
                transcript_id=request.parent_transcript_id,
                for_update=True,
            )
            if forked_at_sequence > parent.current_sequence:
                raise WeworkTranscriptError(
                    "invalid_fork_point",
                    "Wework transcript fork point is newer than its parent",
                    status_code=422,
                )
        transcript = WeworkTranscript(
            user_id=user_id,
            transcript_id=transcript_id,
            parent_transcript_id=parent_transcript_id,
            forked_at_sequence=forked_at_sequence,
            title=request.title or "",
        )
        db.add(transcript)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            transcript = (
                db.query(WeworkTranscript)
                .filter(
                    WeworkTranscript.user_id == user_id,
                    WeworkTranscript.transcript_id == transcript_id,
                )
                .with_for_update()
                .one()
            )
    if (
        transcript.parent_transcript_id != parent_transcript_id
        or transcript.forked_at_sequence != forked_at_sequence
    ):
        raise WeworkTranscriptError(
            "fork_identity_conflict",
            "Wework transcript already exists with a different parent",
        )
    lease_active = transcript.writer_lease_expires_at > now
    if lease_active and transcript.writer_client_id != request.client_id:
        raise WeworkTranscriptError(
            "lease_held",
            "Wework transcript is being edited on another device",
        )
    if transcript.writer_client_id != request.client_id or not lease_active:
        transcript.writer_fencing_token += 1
    transcript.writer_client_id = request.client_id
    transcript.writer_lease_expires_at = now + timedelta(seconds=request.ttl_seconds)
    if request.title is not None:
        transcript.title = request.title
    transcript.updated_at = now
    db.commit()
    db.refresh(transcript)
    return transcript


def renew_lease(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    request: TranscriptLeaseRequest,
    fencing_token: int,
) -> WeworkTranscript:
    transcript = get_transcript(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
        for_update=True,
    )
    _require_lease(transcript, request.client_id, fencing_token)
    transcript.writer_lease_expires_at = utcnow() + timedelta(
        seconds=request.ttl_seconds
    )
    transcript.updated_at = utcnow()
    db.commit()
    db.refresh(transcript)
    return transcript


def release_lease(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    request: TranscriptLeaseReleaseRequest,
) -> WeworkTranscript:
    transcript = get_transcript(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
        for_update=True,
    )
    _require_lease(transcript, request.client_id, request.fencing_token)
    transcript.writer_client_id = ""
    transcript.writer_lease_expires_at = EPOCH_TIME
    transcript.updated_at = utcnow()
    db.commit()
    db.refresh(transcript)
    return transcript


def prepare_segment_upload(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    request: TranscriptSegmentRequest,
) -> tuple[str, dict[str, str], datetime]:
    transcript = get_transcript(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
        for_update=True,
    )
    _validate_segment_write(transcript, request)
    return wework_transcript_storage.upload_policy(
        _segment_object_key(user_id, transcript_id, request),
        request.size_bytes,
    )


def commit_segment(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    request: TranscriptSegmentCommitRequest,
) -> tuple[WeworkTranscript, bool]:
    transcript = get_transcript(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
        for_update=True,
    )
    _require_lease(transcript, request.client_id, request.fencing_token)
    existing_archive = (
        db.query(WeworkTranscriptArchive)
        .filter(
            WeworkTranscriptArchive.transcript_db_id == transcript.id,
            WeworkTranscriptArchive.to_sequence == request.sequence,
        )
        .first()
    )
    existing_turn = (
        db.query(WeworkTranscriptTurn)
        .filter(
            WeworkTranscriptTurn.transcript_db_id == transcript.id,
            (
                (WeworkTranscriptTurn.sequence == request.sequence)
                | (WeworkTranscriptTurn.turn_id == request.turn_id)
            ),
        )
        .first()
    )
    from_sequence = 0 if "snapshot" in request.format else request.sequence
    object_key = _segment_object_key(user_id, transcript_id, request)
    if existing_archive is not None or existing_turn is not None:
        if _segment_matches(
            existing_archive,
            from_sequence=from_sequence,
            object_key=object_key,
            request=request,
        ) and _turn_matches(existing_turn, request):
            return transcript, False
        if existing_archive is not None and not _segment_matches(
            existing_archive,
            from_sequence=from_sequence,
            object_key=object_key,
            request=request,
        ):
            raise WeworkTranscriptError(
                "segment_conflict",
                "A different native segment already exists at this sequence",
            )
        raise WeworkTranscriptError(
            "turn_conflict",
            "A different transcript summary already exists for this turn or sequence",
        )
    _validate_segment_write(transcript, request)
    stored_size, stored_sha256 = wework_transcript_storage.integrity(
        object_key,
        request.size_bytes,
    )
    if stored_size != request.size_bytes:
        raise WeworkTranscriptError(
            "segment_size_mismatch",
            "Uploaded transcript segment size does not match its manifest",
            status_code=422,
        )
    if stored_sha256 != request.sha256:
        raise WeworkTranscriptError(
            "segment_digest_mismatch",
            "Uploaded transcript segment digest does not match its manifest",
            status_code=422,
        )
    db.add(
        WeworkTranscriptArchive(
            transcript_db_id=transcript.id,
            from_sequence=from_sequence,
            to_sequence=request.sequence,
            storage_key=object_key,
            sha256=request.sha256,
            size_bytes=request.size_bytes,
            format=request.format,
        )
    )
    db.add(
        WeworkTranscriptTurn(
            transcript_db_id=transcript.id,
            sequence=request.sequence,
            turn_id=request.turn_id,
            payload=request.summary,
        )
    )
    transcript.current_sequence = request.sequence
    if from_sequence == 0:
        transcript.archived_through_sequence = request.sequence
    transcript.state = "active"
    transcript.archived_at = EPOCH_TIME
    if request.title is not None:
        transcript.title = request.title
    transcript.updated_at = utcnow()
    db.commit()
    db.refresh(transcript)
    _prune_obsolete_segments(db, transcript.id)
    return transcript, True


def list_archives(
    db: Session,
    *,
    transcript_db_id: int,
) -> list[WeworkTranscriptArchive]:
    retained_floor = _retained_archive_floor(db, transcript_db_id)
    return (
        db.query(WeworkTranscriptArchive)
        .filter(
            WeworkTranscriptArchive.transcript_db_id == transcript_db_id,
            WeworkTranscriptArchive.to_sequence >= retained_floor,
        )
        .order_by(WeworkTranscriptArchive.to_sequence)
        .all()
    )


def list_turns(
    db: Session,
    *,
    transcript_db_id: int,
    after_sequence: int,
    limit: int,
) -> list[WeworkTranscriptTurn]:
    return (
        db.query(WeworkTranscriptTurn)
        .filter(
            WeworkTranscriptTurn.transcript_db_id == transcript_db_id,
            WeworkTranscriptTurn.sequence > after_sequence,
        )
        .order_by(WeworkTranscriptTurn.sequence)
        .limit(limit)
        .all()
    )


def get_archive(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    archive_id: int,
) -> WeworkTranscriptArchive:
    transcript = get_transcript(db, user_id=user_id, transcript_id=transcript_id)
    archive = (
        db.query(WeworkTranscriptArchive)
        .filter(
            WeworkTranscriptArchive.id == archive_id,
            WeworkTranscriptArchive.transcript_db_id == transcript.id,
        )
        .first()
    )
    if archive is None:
        raise WeworkTranscriptError(
            "archive_not_found",
            "Wework transcript segment not found",
            status_code=404,
        )
    if archive.to_sequence < _retained_archive_floor(db, transcript.id):
        raise WeworkTranscriptError(
            "archive_not_found",
            "Wework transcript segment not found",
            status_code=404,
        )
    return archive


def archive_transcript(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    request: TranscriptArchiveRequest,
) -> WeworkTranscript:
    transcript = get_transcript(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
        for_update=True,
    )
    _require_lease(transcript, request.client_id, request.fencing_token)
    transcript.state = "archived"
    transcript.archived_at = utcnow()
    transcript.writer_client_id = ""
    transcript.writer_lease_expires_at = EPOCH_TIME
    transcript.updated_at = utcnow()
    db.commit()
    db.refresh(transcript)
    return transcript


def _validate_fork_request(request: TranscriptLeaseRequest) -> None:
    has_parent = request.parent_transcript_id is not None
    has_fork_point = request.forked_at_sequence is not None
    if has_parent != has_fork_point:
        raise WeworkTranscriptError(
            "invalid_fork",
            "Wework transcript parent and fork point must be provided together",
            status_code=422,
        )


def _validate_segment_write(
    transcript: WeworkTranscript,
    request: TranscriptSegmentRequest,
) -> None:
    _require_lease(transcript, request.client_id, request.fencing_token)
    if request.sequence != request.base_sequence + 1:
        raise WeworkTranscriptError(
            "invalid_sequence",
            "A transcript segment must advance exactly one sequence",
            status_code=422,
        )
    if transcript.current_sequence != request.base_sequence:
        raise WeworkTranscriptError(
            "sequence_conflict",
            "Transcript sequence has changed; create a full snapshot branch",
        )


def _segment_object_key(
    user_id: int,
    transcript_id: str,
    request: TranscriptSegmentRequest,
) -> str:
    transcript_key = hashlib.sha256(transcript_id.encode()).hexdigest()
    kind = "snapshot" if "snapshot" in request.format else "delta"
    return (
        f"users/{user_id}/transcripts/{transcript_key}/"
        f"{request.sequence}-{kind}-{request.sha256}.tgz.aes256gcm"
    )


def _segment_matches(
    archive: WeworkTranscriptArchive | None,
    *,
    from_sequence: int,
    object_key: str,
    request: TranscriptSegmentCommitRequest,
) -> bool:
    return archive is not None and (
        archive.from_sequence == from_sequence
        and archive.storage_key == object_key
        and archive.sha256 == request.sha256
        and archive.size_bytes == request.size_bytes
        and archive.format == request.format
    )


def _turn_matches(
    turn: WeworkTranscriptTurn | None,
    request: TranscriptSegmentCommitRequest,
) -> bool:
    return turn is not None and (
        turn.sequence == request.sequence
        and turn.turn_id == request.turn_id
        and turn.payload == request.summary
    )


def _prune_obsolete_segments(db: Session, transcript_db_id: int) -> None:
    snapshots = (
        db.query(WeworkTranscriptArchive)
        .filter(
            WeworkTranscriptArchive.transcript_db_id == transcript_db_id,
            WeworkTranscriptArchive.from_sequence == 0,
        )
        .order_by(WeworkTranscriptArchive.to_sequence.desc())
        .all()
    )
    if len(snapshots) < 2:
        return
    retained_snapshot_sequence = snapshots[1].to_sequence
    obsolete = (
        db.query(WeworkTranscriptArchive)
        .filter(
            WeworkTranscriptArchive.transcript_db_id == transcript_db_id,
            WeworkTranscriptArchive.to_sequence < retained_snapshot_sequence,
        )
        .order_by(WeworkTranscriptArchive.to_sequence)
        .limit(MAX_SEGMENTS_PRUNED_PER_COMMIT)
        .all()
    )
    for segment in obsolete:
        try:
            wework_transcript_storage.delete(segment.storage_key)
        except WeworkTranscriptStorageError:
            logger.warning(
                "Failed to prune obsolete Wework transcript segment",
                extra={
                    "transcript_db_id": transcript_db_id,
                    "sequence": segment.to_sequence,
                },
                exc_info=True,
            )
            continue
        try:
            db.delete(segment)
            db.commit()
        except SQLAlchemyError:
            db.rollback()
            logger.warning(
                "Failed to remove pruned Wework transcript metadata",
                extra={
                    "transcript_db_id": transcript_db_id,
                    "sequence": segment.to_sequence,
                },
                exc_info=True,
            )


def _retained_archive_floor(db: Session, transcript_db_id: int) -> int:
    snapshots = (
        db.query(WeworkTranscriptArchive.to_sequence)
        .filter(
            WeworkTranscriptArchive.transcript_db_id == transcript_db_id,
            WeworkTranscriptArchive.from_sequence == 0,
        )
        .order_by(WeworkTranscriptArchive.to_sequence.desc())
        .limit(2)
        .all()
    )
    return snapshots[1][0] if len(snapshots) == 2 else 0


def _require_lease(
    transcript: WeworkTranscript,
    client_id: str,
    fencing_token: int,
) -> None:
    if (
        transcript.writer_client_id != client_id
        or transcript.writer_fencing_token != fencing_token
        or transcript.writer_lease_expires_at <= utcnow()
    ):
        raise WeworkTranscriptError(
            "lease_invalid",
            "Wework transcript write lease is missing, expired, or stale",
        )
