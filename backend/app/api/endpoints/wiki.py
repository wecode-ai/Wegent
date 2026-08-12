# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.wiki_config import wiki_settings
from app.db.session import get_wiki_db
from app.models.kind import Kind
from app.models.user import User
from app.models.wiki import WikiGeneration, WikiGenerationStatus
from app.schemas.knowledge import KnowledgeBaseType
from app.schemas.wiki import WikiContentWriteRequest, WikiPageRead
from app.services.knowledge.code_wiki.generation import FailureCode, failure_code
from app.services.knowledge.code_wiki.prompts import build_diagram_correction
from app.services.knowledge.code_wiki.publish_gate import PUBLISH_GATE_EXT_KEY
from app.services.knowledge.code_wiki.publisher import published_generation_id
from app.services.wiki_service import wiki_service

logger = logging.getLogger(__name__)

internal_router = APIRouter()


def _verify_internal_token(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> User:
    """Resolve an internal writer credential to its active user."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
        )
    token = authorization[7:].strip()

    # A user JWT is available to the executor through TASK_INFO.
    try:
        user = security.get_current_user_from_token(token, db)
        if user and user.is_active:
            return user
    except Exception as e:
        logger.debug(f"JWT token verification failed: {e}")

    # A skill identity token is the credential held by wiki_submit itself.
    user = _user_from_skill_identity(token, db)
    if user is not None:
        return user

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Invalid authorization token",
    )


def _user_from_skill_identity(token: str, db: Session) -> Optional[User]:
    """The user a skill identity token stands for, or ``None``.

    Same shape as the skill download endpoints use, so a skill authenticates the
    same way wherever it calls back to.
    """
    from app.services.auth import verify_skill_identity_token

    token_info = verify_skill_identity_token(token)
    if not token_info:
        return None
    user = db.query(User).filter(User.id == token_info.user_id).first()
    if not user or not user.is_active or user.user_name != token_info.user_name:
        return None
    return user


def _internal_caller(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> User:
    """Authenticate an internal caller as an active user."""
    return _verify_internal_token(authorization=authorization, db=db)


def _assert_caller_owns_generation(
    wiki_db: Session, caller: User, generation_id: int
) -> WikiGeneration:
    """Refuse a caller asking about a generation that is not theirs.

    Authenticating a JWT says who is asking, not what they may ask about. Without
    this any signed-in user could read any generation's pages, which is a different
    thing from the documented "your own version" — and that version is a copy of a
    wiki whose repository they may have no access to at all.
    """
    if caller is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="An active user identity is required",
        )

    generation = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.id == generation_id)
        .with_for_update()
        .first()
    )
    if generation is None:
        raise HTTPException(status_code=404, detail="Generation not found")
    if generation.user_id != caller.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This generation belongs to another account",
        )
    return generation


def _assert_caller_may_write_generation(
    wiki_db: Session, caller: User, generation_id: int
) -> None:
    """Require the executing user and an explicitly correctable Code Wiki run."""
    generation = _assert_caller_owns_generation(wiki_db, caller, generation_id)
    if not generation.kind_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Generation does not belong to an active Code Wiki",
        )

    knowledge_base = wiki_db.get(Kind, generation.kind_id)
    spec = (knowledge_base.json or {}).get("spec", {}) if knowledge_base else {}
    if (
        knowledge_base is None
        or not knowledge_base.is_active
        or knowledge_base.kind != "KnowledgeBase"
        or spec.get("kbType") != KnowledgeBaseType.CODE_WIKI.value
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Generation does not belong to an active Code Wiki",
        )

    if generation.status == WikiGenerationStatus.RUNNING:
        return
    if (
        generation.status == WikiGenerationStatus.FAILED
        and failure_code(generation) == FailureCode.PUBLISH_REFUSED
    ):
        return

    publish_gate = (generation.ext or {}).get(PUBLISH_GATE_EXT_KEY, {}) or {}
    if (
        generation.status == WikiGenerationStatus.COMPLETED
        and published_generation_id(knowledge_base) == generation.id
        and publish_gate.get("correctionPending") is True
    ):
        return

    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Generation is not in a writable state",
    )


@internal_router.post("/generations/contents")
def save_wiki_generation_contents(
    payload: WikiContentWriteRequest,
    caller: User = Depends(_internal_caller),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Write wiki generation contents and update status (internal use).

    Answers with the publish outcome when a run concludes. It used to answer 204 and
    say nothing, so an agent whose version the gate refused was told its run was
    complete while its work was discarded — and it is the only party that could still
    act on the refusal, since it is running and its checkout is there.

    ``corrections`` carries the same argument one step further. Broken diagrams never
    hold a version back, so the run publishes and ends — and the finding was recorded
    where only a human reading the run history would ever see it, which is the one
    party that cannot fix a diagram. Returned here it reaches the agent while it can
    still rewrite the page and finish again.
    """
    _assert_caller_may_write_generation(wiki_db, caller, payload.generation_id)
    outcome = wiki_service.save_generation_contents(
        wiki_db=wiki_db,
        payload=payload,
    )
    if outcome is None:
        return {"published": True, "reason": "", "corrections": ""}
    return {
        "published": outcome.published,
        "reason": outcome.reason,
        "corrections": build_diagram_correction(outcome.verdict.diagram_warnings) or "",
    }


@internal_router.get("/generations/{generation_id}/pages", response_model=WikiPageRead)
def read_wiki_generation_page(
    generation_id: int,
    path: str = Query(..., min_length=1, description="Stable page path to read"),
    caller: User = Depends(_internal_caller),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Read one page of the version the agent is writing into (internal use).

    An incremental version begins as a complete copy of the published wiki, so the
    agent's own generation is also the current wiki — which makes "read your own
    version" both the capability it needs and the narrowest scope that provides it.
    Without this the instruction to revise a page cannot be followed: the agent knows
    the page's path and cannot see a word of what it says.

    Answers 404 when the path holds no page. That is a useful answer rather than a
    failure — in an incremental run it means the page is new.
    """
    _assert_caller_owns_generation(wiki_db, caller, generation_id)
    page = wiki_service.get_generation_page(
        wiki_db=wiki_db, generation_id=generation_id, path=path
    )
    if page is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Generation {generation_id} has no page at '{path}'",
        )
    return page
