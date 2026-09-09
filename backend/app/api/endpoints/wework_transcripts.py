# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cross-device Wework transcript synchronization endpoints."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.models.wework_transcript import (
    EPOCH_TIME,
    WeworkTranscript,
    WeworkTranscriptArchive,
)
from app.schemas.wework_transcript import (
    TranscriptAppendResponse,
    TranscriptArchiveRequest,
    TranscriptArchiveResponse,
    TranscriptLeaseReleaseRequest,
    TranscriptLeaseRequest,
    TranscriptLeaseResponse,
    TranscriptListResponse,
    TranscriptResponse,
    TranscriptTurnAppendRequest,
    TranscriptTurnResponse,
    TranscriptTurnsResponse,
)
from app.services import wework_transcript_service
from app.services.wework_transcript_service import WeworkTranscriptError
from app.services.wework_transcript_storage import (
    WeworkTranscriptStorageError,
    wework_transcript_storage,
)

router = APIRouter()


@router.get("", response_model=TranscriptListResponse, response_model_by_alias=True)
def list_transcripts_endpoint(
    include_archived: bool = Query(default=True, alias="includeArchived"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    transcripts = wework_transcript_service.list_transcripts(
        db,
        user_id=current_user.id,
        include_archived=include_archived,
    )
    return {"items": [_transcript_response(db, item) for item in transcripts]}


@router.get(
    "/{transcript_id}",
    response_model=TranscriptResponse,
    response_model_by_alias=True,
)
def get_transcript_endpoint(
    transcript_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _translate(
        lambda: _transcript_response(
            db,
            wework_transcript_service.get_transcript(
                db,
                user_id=current_user.id,
                transcript_id=transcript_id,
            ),
        )
    )


@router.post(
    "/{transcript_id}/lease",
    response_model=TranscriptLeaseResponse,
    response_model_by_alias=True,
)
def acquire_lease_endpoint(
    transcript_id: str,
    request: TranscriptLeaseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    transcript = _translate(
        lambda: wework_transcript_service.acquire_lease(
            db,
            user_id=current_user.id,
            transcript_id=transcript_id,
            request=request,
        )
    )
    return _lease_response(transcript)


@router.put(
    "/{transcript_id}/lease/{fencing_token}",
    response_model=TranscriptLeaseResponse,
    response_model_by_alias=True,
)
def renew_lease_endpoint(
    transcript_id: str,
    fencing_token: int,
    request: TranscriptLeaseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    transcript = _translate(
        lambda: wework_transcript_service.renew_lease(
            db,
            user_id=current_user.id,
            transcript_id=transcript_id,
            request=request,
            fencing_token=fencing_token,
        )
    )
    return _lease_response(transcript)


@router.post("/{transcript_id}/lease/release")
def release_lease_endpoint(
    transcript_id: str,
    request: TranscriptLeaseReleaseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _translate(
        lambda: wework_transcript_service.release_lease(
            db,
            user_id=current_user.id,
            transcript_id=transcript_id,
            request=request,
        )
    )
    return {"released": True}


@router.post(
    "/{transcript_id}/turns",
    response_model=TranscriptAppendResponse,
    response_model_by_alias=True,
)
def append_turns_endpoint(
    transcript_id: str,
    request: TranscriptTurnAppendRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    transcript, appended = _translate(
        lambda: wework_transcript_service.append_turns(
            db,
            user_id=current_user.id,
            transcript_id=transcript_id,
            request=request,
        )
    )
    return {
        "currentSequence": transcript.current_sequence,
        "appended": appended,
    }


@router.get(
    "/{transcript_id}/turns",
    response_model=TranscriptTurnsResponse,
    response_model_by_alias=True,
)
def list_turns_endpoint(
    transcript_id: str,
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    transcript, turns, has_more = _translate(
        lambda: wework_transcript_service.list_turns(
            db,
            user_id=current_user.id,
            transcript_id=transcript_id,
            after=after,
            limit=limit,
        )
    )
    return {
        "turns": [
            TranscriptTurnResponse(
                turnId=turn.turn_id,
                sequence=turn.sequence,
                payload=turn.payload,
                createdAt=turn.created_at,
            )
            for turn in turns
        ],
        "currentSequence": transcript.current_sequence,
        "archivedThroughSequence": transcript.archived_through_sequence,
        "hasMore": has_more,
    }


@router.post(
    "/{transcript_id}/archive",
    response_model=TranscriptResponse,
    response_model_by_alias=True,
)
def archive_transcript_endpoint(
    transcript_id: str,
    request: TranscriptArchiveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    transcript, _archive = _translate(
        lambda: wework_transcript_service.archive_transcript(
            db,
            user_id=current_user.id,
            transcript_id=transcript_id,
            request=request,
        )
    )
    return _transcript_response(db, transcript)


@router.get("/{transcript_id}/archives/{archive_id}/download")
def get_archive_download_endpoint(
    transcript_id: str,
    archive_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    archive = _translate(
        lambda: wework_transcript_service.get_archive(
            db,
            user_id=current_user.id,
            transcript_id=transcript_id,
            archive_id=archive_id,
        )
    )
    return {
        "downloadUrl": _translate(
            lambda: wework_transcript_storage.download_url(archive.storage_key)
        )
    }


@router.get(
    "/{transcript_id}/archives/{archive_id}/turns",
    response_model=TranscriptTurnsResponse,
    response_model_by_alias=True,
)
def list_archive_turns_endpoint(
    transcript_id: str,
    archive_id: int,
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=1000, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    archive, turns, has_more = _translate(
        lambda: wework_transcript_service.list_archive_turns(
            db,
            user_id=current_user.id,
            transcript_id=transcript_id,
            archive_id=archive_id,
            after=after,
            limit=limit,
        )
    )
    return {
        "turns": turns,
        "currentSequence": archive.to_sequence,
        "archivedThroughSequence": archive.to_sequence,
        "hasMore": has_more,
    }


def _lease_response(transcript: WeworkTranscript) -> TranscriptLeaseResponse:
    return TranscriptLeaseResponse(
        transcriptId=transcript.transcript_id,
        clientId=transcript.writer_client_id,
        fencingToken=transcript.writer_fencing_token,
        expiresAt=transcript.writer_lease_expires_at,
        currentSequence=transcript.current_sequence,
    )


def _transcript_response(
    db: Session,
    transcript: WeworkTranscript,
) -> TranscriptResponse:
    archives = wework_transcript_service.list_archives(
        db,
        transcript_db_id=transcript.id,
    )
    return TranscriptResponse(
        transcriptId=transcript.transcript_id,
        parentTranscriptId=transcript.parent_transcript_id or None,
        forkedAtSequence=(
            transcript.forked_at_sequence if transcript.parent_transcript_id else None
        ),
        title=transcript.title,
        state=transcript.state,
        currentSequence=transcript.current_sequence,
        archivedThroughSequence=transcript.archived_through_sequence,
        writerClientId=transcript.writer_client_id or None,
        writerLeaseExpiresAt=_optional_datetime(transcript.writer_lease_expires_at),
        archives=[_archive_response(item) for item in archives],
        createdAt=transcript.created_at,
        updatedAt=transcript.updated_at,
        archivedAt=_optional_datetime(transcript.archived_at),
    )


def _archive_response(
    archive: WeworkTranscriptArchive,
) -> TranscriptArchiveResponse:
    return TranscriptArchiveResponse(
        id=archive.id,
        fromSequence=archive.from_sequence,
        toSequence=archive.to_sequence,
        sha256=archive.sha256,
        sizeBytes=archive.size_bytes,
        format=archive.format,
        createdAt=archive.created_at,
    )


def _optional_datetime(value: datetime) -> datetime | None:
    return None if value == EPOCH_TIME else value


def _translate(action):
    try:
        return action()
    except WeworkTranscriptError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except WeworkTranscriptStorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
