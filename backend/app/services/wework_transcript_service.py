# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Synchronization and hot/cold storage for Wework transcripts."""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import zstandard
from sqlalchemy.exc import IntegrityError
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
    TranscriptTurnAppendRequest,
)
from app.services.wework_transcript_storage import wework_transcript_storage


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


def _validate_fork_request(request: TranscriptLeaseRequest) -> None:
    has_parent = request.parent_transcript_id is not None
    has_fork_point = request.forked_at_sequence is not None
    if has_parent != has_fork_point:
        raise WeworkTranscriptError(
            "invalid_fork",
            "Wework transcript parent and fork point must be provided together",
            status_code=422,
        )


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


def append_turns(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    request: TranscriptTurnAppendRequest,
) -> tuple[WeworkTranscript, int]:
    transcript = get_transcript(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
        for_update=True,
    )
    _require_lease(transcript, request.client_id, request.fencing_token)
    if request.turns[-1].sequence <= transcript.archived_through_sequence:
        return transcript, 0

    expected = request.base_sequence + 1
    for turn in request.turns:
        if turn.sequence != expected:
            raise WeworkTranscriptError(
                "invalid_sequence",
                "Transcript turns must contain a contiguous sequence",
                status_code=422,
            )
        expected += 1

    existing_turns = {
        row.turn_id: row
        for row in db.query(WeworkTranscriptTurn)
        .filter(
            WeworkTranscriptTurn.transcript_db_id == transcript.id,
            WeworkTranscriptTurn.turn_id.in_([turn.turn_id for turn in request.turns]),
        )
        .all()
    }
    if len(existing_turns) == len(request.turns) and all(
        existing_turns[turn.turn_id].sequence == turn.sequence
        and existing_turns[turn.turn_id].payload == turn.payload
        for turn in request.turns
    ):
        return transcript, 0

    if transcript.current_sequence != request.base_sequence:
        raise WeworkTranscriptError(
            "sequence_conflict",
            "Transcript sequence has changed; pull remote turns before retrying",
        )

    if existing_turns:
        raise WeworkTranscriptError(
            "turn_conflict",
            "One or more transcript turns already exist with a different sequence",
        )

    for turn in request.turns:
        db.add(
            WeworkTranscriptTurn(
                transcript_db_id=transcript.id,
                sequence=turn.sequence,
                turn_id=turn.turn_id,
                payload=turn.payload,
            )
        )
    transcript.current_sequence = request.turns[-1].sequence
    transcript.state = "active"
    transcript.archived_at = EPOCH_TIME
    if request.title is not None:
        transcript.title = request.title
    transcript.updated_at = utcnow()
    db.commit()
    db.refresh(transcript)
    return transcript, len(request.turns)


def list_turns(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    after: int,
    limit: int,
) -> tuple[WeworkTranscript, list[WeworkTranscriptTurn], bool]:
    transcript = get_transcript(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
    )
    rows = (
        db.query(WeworkTranscriptTurn)
        .filter(
            WeworkTranscriptTurn.transcript_db_id == transcript.id,
            WeworkTranscriptTurn.sequence > after,
        )
        .order_by(WeworkTranscriptTurn.sequence)
        .limit(limit + 1)
        .all()
    )
    return transcript, rows[:limit], len(rows) > limit


def list_archives(
    db: Session,
    *,
    transcript_db_id: int,
) -> list[WeworkTranscriptArchive]:
    return (
        db.query(WeworkTranscriptArchive)
        .filter(WeworkTranscriptArchive.transcript_db_id == transcript_db_id)
        .order_by(WeworkTranscriptArchive.from_sequence)
        .all()
    )


def get_archive(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    archive_id: int,
) -> WeworkTranscriptArchive:
    transcript = get_transcript(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
    )
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
            "Wework transcript archive not found",
            status_code=404,
        )
    return archive


def list_archive_turns(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    archive_id: int,
    after: int,
    limit: int,
) -> tuple[WeworkTranscriptArchive, list[dict[str, Any]], bool]:
    archive = get_archive(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
        archive_id=archive_id,
    )
    content = wework_transcript_storage.get(archive.storage_key)
    if hashlib.sha256(content).hexdigest() != archive.sha256:
        raise WeworkTranscriptStorageError(
            "Archived Wework transcript failed integrity verification"
        )
    try:
        decoded = zstandard.ZstdDecompressor().decompress(content)
        turns = [json.loads(line) for line in decoded.splitlines() if line]
    except (json.JSONDecodeError, zstandard.ZstdError) as exc:
        raise WeworkTranscriptStorageError(
            "Archived Wework transcript is invalid"
        ) from exc
    selected = [turn for turn in turns if turn["sequence"] > after]
    return archive, selected[:limit], len(selected) > limit


def archive_transcript(
    db: Session,
    *,
    user_id: int,
    transcript_id: str,
    request: TranscriptArchiveRequest,
) -> tuple[WeworkTranscript, WeworkTranscriptArchive | None]:
    transcript = get_transcript(
        db,
        user_id=user_id,
        transcript_id=transcript_id,
        for_update=True,
    )
    _require_lease(transcript, request.client_id, request.fencing_token)
    turns = (
        db.query(WeworkTranscriptTurn)
        .filter(WeworkTranscriptTurn.transcript_db_id == transcript.id)
        .order_by(WeworkTranscriptTurn.sequence)
        .all()
    )
    archive = None
    if turns:
        content = _archive_content(turns)
        digest = hashlib.sha256(content).hexdigest()
        from_sequence = turns[0].sequence
        to_sequence = turns[-1].sequence
        transcript_key = hashlib.sha256(transcript_id.encode()).hexdigest()
        object_key = (
            f"users/{user_id}/transcripts/{transcript_key}/"
            f"{from_sequence}-{to_sequence}-{digest}.jsonl.zst"
        )
        wework_transcript_storage.put(object_key, content)
        archive = WeworkTranscriptArchive(
            transcript_db_id=transcript.id,
            from_sequence=from_sequence,
            to_sequence=to_sequence,
            storage_key=object_key,
            sha256=digest,
            size_bytes=len(content),
        )
        db.add(archive)
        db.query(WeworkTranscriptTurn).filter(
            WeworkTranscriptTurn.transcript_db_id == transcript.id,
            WeworkTranscriptTurn.sequence <= to_sequence,
        ).delete(synchronize_session=False)
        transcript.archived_through_sequence = to_sequence

    transcript.state = "archived"
    transcript.archived_at = utcnow()
    transcript.writer_client_id = ""
    transcript.writer_lease_expires_at = EPOCH_TIME
    transcript.updated_at = utcnow()
    db.commit()
    db.refresh(transcript)
    if archive is not None:
        db.refresh(archive)
    return transcript, archive


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


def _archive_content(turns: list[WeworkTranscriptTurn]) -> bytes:
    lines = []
    for turn in turns:
        value: dict[str, Any] = {
            "sequence": turn.sequence,
            "turnId": turn.turn_id,
            "payload": turn.payload,
            "createdAt": turn.created_at.isoformat(),
        }
        lines.append(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        )
    return zstandard.ZstdCompressor(level=6).compress(b"\n".join(lines) + b"\n")
