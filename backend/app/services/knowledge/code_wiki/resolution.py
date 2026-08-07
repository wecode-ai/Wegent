# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""What a caller needs to know about a repository before binding a wiki to it.

One call answers three questions that would otherwise be three probes:

1. **May this caller read it?** — which decides whether creating a wiki is allowed.
2. **What is its default branch?** — so the create form does not need a branch listing,
   which has no anonymous path and would be a second thing to open up.
3. **What is it called, and what is it?** — used to fill in a name and description the
   caller left blank.

Repositories can be read without a credential when they are public, and that case has
to work: the repository selector only lists repositories the caller is a member of, so
a public repository is one they can read in a browser but cannot pick from a list. A
wiki that could not be built for it would be more closed than the thing it documents.

Anonymous requests to GitHub are limited to 60 an hour per address, so results are
cached. The cache is keyed by whether a credential was used, because the same
repository legitimately answers differently with and without one.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.services.git_skill.utils import get_user_git_info
from app.services.knowledge.code_wiki.source import (
    SUPPORTED_SOURCE_TYPES,
    SourceAccessDenied,
    SourceRepository,
    provider_for,
)

logger = logging.getLogger(__name__)

# Long enough that a form filled in over several minutes costs one request, short
# enough that a repository turned private stops being reported as public within the
# hour. Visibility is a cache here, never a stored fact.
RESOLUTION_CACHE_SECONDS = 600


@dataclass(frozen=True)
class ResolvedRepository:
    """A repository the caller may read, described well enough to bind."""

    exists: bool
    visibility: str
    default_branch: str
    name: str
    description: str
    access: str  # "public" | "member" | "none"


UNREADABLE = ResolvedRepository(
    exists=False,
    visibility="",
    default_branch="",
    name="",
    description="",
    access="none",
)


def resolve_repository(
    db: Session, user_id: int, source: SourceRepository
) -> ResolvedRepository:
    """Describe a repository as far as this caller is entitled to see it.

    Never raises for an unreadable repository: "you cannot read this" is an answer
    the form displays, not an error. Absent and private are reported identically,
    since telling them apart would disclose which private repositories exist.
    """
    if source.source_type not in SUPPORTED_SOURCE_TYPES:
        raise SourceAccessDenied(
            f"Unsupported repository type '{source.source_type}'. "
            f"Supported types: {', '.join(SUPPORTED_SOURCE_TYPES)}"
        )

    provider = provider_for(source.source_type)
    if provider is None:  # pragma: no cover - guarded by the check above
        return UNREADABLE

    git_info = get_user_git_info(user_id=user_id, domain=source.source_domain, db=db)
    token = (git_info or {}).get("token") or ""

    cached = _cached(source, has_token=bool(token))
    if cached is not None:
        return cached

    described = provider.describe_repository(
        token=token,
        git_domain=source.source_domain,
        repo_name=source.project_name,
    )
    if not described:
        # Not cached: a repository that is about to be granted to the caller should
        # not stay unreadable for ten minutes because they asked one moment early.
        return UNREADABLE

    resolved = ResolvedRepository(
        exists=True,
        visibility=str(described.get("visibility") or "private"),
        default_branch=str(described.get("default_branch") or ""),
        name=str(described.get("name") or source.project_name),
        description=str(described.get("description") or ""),
        access="member" if token else "public",
    )
    _remember(source, has_token=bool(token), resolved=resolved)
    return resolved


def _cache_key(source: SourceRepository, *, has_token: bool) -> str:
    return (
        f"code_wiki:resolve:{source.source_type}:{source.source_domain}:"
        f"{source.project_name}:{'auth' if has_token else 'anon'}"
    )


def _cached(
    source: SourceRepository, *, has_token: bool
) -> Optional[ResolvedRepository]:
    try:
        payload = _run(cache_manager.get(_cache_key(source, has_token=has_token)))
    except Exception as exc:  # pragma: no cover - cache is an optimisation
        logger.debug("[code_wiki] resolution cache read failed: %s", exc)
        return None
    if not isinstance(payload, dict):
        return None
    return ResolvedRepository(**payload)


def _remember(
    source: SourceRepository, *, has_token: bool, resolved: ResolvedRepository
) -> None:
    try:
        _run(
            cache_manager.set(
                _cache_key(source, has_token=has_token),
                resolved.__dict__,
                expire=RESOLUTION_CACHE_SECONDS,
            )
        )
    except Exception as exc:  # pragma: no cover - cache is an optimisation
        logger.debug("[code_wiki] resolution cache write failed: %s", exc)


def _run(coroutine):
    """Await a cache coroutine from this synchronous path.

    The endpoint is synchronous, so there is no running loop to attach to; a fresh
    one per call is the same shape the repository providers already use.
    """
    import asyncio

    return asyncio.run(coroutine)
