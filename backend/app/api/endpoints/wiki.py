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
from app.models.user import User
from app.models.wiki import WikiGeneration
from app.schemas.wiki import WikiContentWriteRequest, WikiPageRead
from app.services.knowledge.code_wiki.prompts import build_diagram_correction
from app.services.wiki_service import wiki_service

logger = logging.getLogger(__name__)

internal_router = APIRouter()


def _verify_internal_token(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> None:
    """
    Verify authorization token for internal content writer.

    Supports two authentication methods:
    1. Internal API token (legacy): Fixed token from wiki_settings.INTERNAL_API_TOKEN
    2. User JWT token (recommended): Standard JWT token from task execution context

    The user JWT token is automatically available in the executor container via
    TASK_INFO environment variable, making it the preferred method for wiki_submit skill.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
        )
    token = authorization[7:].strip()

    # First, try internal API token (legacy method)
    if token == wiki_settings.INTERNAL_API_TOKEN:
        logger.debug("Wiki content write authenticated via internal API token")
        return

    # Second, try user JWT token (recommended method)
    try:
        # Verify JWT token and get user
        user = security.get_current_user_from_token(token, db)
        if user and user.is_active:
            logger.debug(
                f"Wiki content write authenticated via JWT token for user {user.id}"
            )
            return
    except Exception as e:
        logger.debug(f"JWT token verification failed: {e}")
        pass

    # Third, a skill identity token. This is what a skill running inside an executor
    # actually holds: the task token it is also given carries no `sub`, so the user
    # lookup above rejects it. Without this the write API is reachable only with the
    # fixed operator token, which no executor is issued.
    if _user_from_skill_identity(token, db) is not None:
        return

    # If neither method works, reject the request
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Invalid authorization token. Use either internal API token or valid user JWT token.",
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
) -> Optional[User]:
    """Authenticate an internal caller and say which user it is, if any.

    ``None`` means the fixed internal token was used, which is a trusted operator
    rather than a person and is not scoped to one generation.
    """
    _verify_internal_token(authorization=authorization, db=db)
    token = authorization[7:].strip()
    if token == wiki_settings.INTERNAL_API_TOKEN:
        return None
    try:
        return security.get_current_user_from_token(token, db)
    except Exception:  # pragma: no cover - _verify_internal_token already accepted it
        return _user_from_skill_identity(token, db)


def _assert_caller_owns_generation(
    wiki_db: Session, caller: Optional[User], generation_id: int
) -> None:
    """Refuse a caller asking about a generation that is not theirs.

    Authenticating a JWT says who is asking, not what they may ask about. Without
    this any signed-in user could read any generation's pages, which is a different
    thing from the documented "your own version" — and that version is a copy of a
    wiki whose repository they may have no access to at all.
    """
    if caller is None:
        return

    generation = (
        wiki_db.query(WikiGeneration).filter(WikiGeneration.id == generation_id).first()
    )
    if generation is None:
        raise HTTPException(status_code=404, detail="Generation not found")
    if generation.user_id != caller.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This generation belongs to another account",
        )


@internal_router.post("/generations/contents")
def save_wiki_generation_contents(
    payload: WikiContentWriteRequest,
    _: None = Depends(_verify_internal_token),
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
    caller: Optional[User] = Depends(_internal_caller),
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
