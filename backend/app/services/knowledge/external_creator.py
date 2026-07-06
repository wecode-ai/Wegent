# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Creator resolution helpers for external knowledge MCP responses."""

import logging
from typing import Callable

from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.knowledge_external import ExternalKnowledgeCreatorInfo

logger = logging.getLogger(__name__)

ExternalKnowledgeCreatorResolver = Callable[
    [Session, list[int]], dict[int, ExternalKnowledgeCreatorInfo]
]


def _unique_positive_user_ids(user_ids: list[int]) -> list[int]:
    seen: set[int] = set()
    result: list[int] = []
    for user_id in user_ids:
        if type(user_id) is not int or user_id <= 0 or user_id in seen:
            continue
        seen.add(user_id)
        result.append(user_id)
    return result


def default_external_knowledge_creator_resolver(
    db: Session,
    user_ids: list[int],
) -> dict[int, ExternalKnowledgeCreatorInfo]:
    """Resolve creator info from the public users table."""
    normalized_user_ids = _unique_positive_user_ids(user_ids)
    if not normalized_user_ids:
        return {}

    rows = db.query(User).filter(User.id.in_(normalized_user_ids)).all()
    return {
        user.id: ExternalKnowledgeCreatorInfo(
            user_id=user.id,
            user_name=user.user_name,
            attributes={},
        )
        for user in rows
    }


_creator_resolver: ExternalKnowledgeCreatorResolver = (
    default_external_knowledge_creator_resolver
)


def set_external_knowledge_creator_resolver(
    resolver: ExternalKnowledgeCreatorResolver,
) -> None:
    """Replace the external knowledge creator resolver for a deployment."""
    global _creator_resolver
    _creator_resolver = resolver


def resolve_external_knowledge_creators(
    db: Session,
    user_ids: list[int],
) -> dict[int, ExternalKnowledgeCreatorInfo]:
    """Resolve creators without letting resolver failures break main responses."""
    normalized_user_ids = _unique_positive_user_ids(user_ids)
    if not normalized_user_ids:
        return {}
    try:
        return _creator_resolver(db, normalized_user_ids)
    except Exception as exc:
        logger.exception("External knowledge creator resolver failed: %s", exc)
        return default_external_knowledge_creator_resolver(db, normalized_user_ids)
