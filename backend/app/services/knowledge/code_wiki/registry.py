# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Which repository a code wiki documents.

A code wiki is an ordinary knowledge base owned by whoever created it, so the
ordinary ACL decides who may read it. The repository is consulted once, when the
wiki is created, and never tracked afterwards.

**A repository may have several wikis.** One per person who built one: since a wiki
created by A is invisible to B under A's ACL, refusing B a wiki of their own would
take it away on a first-come basis. ``wiki_projects`` therefore holds one row per
``(repository, wiki)`` rather than one per repository, and the composite UNIQUE is
what settles two requests racing for the same pair — a check against a JSON field on
the knowledge base could not, leaving a window between the read and the insert
exactly wide enough for the case worth preventing.

Rows with ``kind_id = 0`` belong to the legacy wiki, at most one per repository.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.models.wiki import WikiProject
from app.services.knowledge.code_wiki.source import SourceRepository

logger = logging.getLogger(__name__)

# Where a code wiki lands when the caller expressed no preference. Unlike every
# other decision here this one is a plain default, not a constraint: the creator may
# file a wiki in any namespace they could file a knowledge base in.
CODE_WIKI_NAMESPACE = "default"


def claim_repository(
    db: Session, source: SourceRepository, kind_id: int
) -> WikiProject:
    """Register that ``kind_id`` is a wiki of this repository.

    Flushed rather than committed: the caller owns the transaction, so a failure
    later in the same request must take this row with it. The row is returned
    because every version of this wiki has to point at it — ``wiki_generations``
    carries a real foreign key to it.
    """
    project = WikiProject(
        project_name=source.project_name,
        project_type="git",
        source_type=source.source_type,
        source_url=source.source_url,
        source_domain=source.source_domain,
        # Empty rather than left out. `wiki_tables.sql` declares this NOT NULL with
        # an empty default, and an omitted column is sent as an explicit NULL, which
        # overrides that default and fails the insert. A repository resolved from its
        # URL has no platform id to record, and "" is how the legacy rows say so.
        source_id="",
        description="",
        ext={},
        kind_id=kind_id,
        is_active=True,
    )
    db.add(project)
    db.flush()
    logger.info(
        "[code_wiki] registered repository %s as project %s for kb %s",
        source.project_name,
        project.id,
        kind_id,
    )
    return project


def existing_wiki_id(
    db: Session, source: SourceRepository, *, owner_id: int
) -> Optional[int]:
    """This caller's own wiki of this repository, if they already have one.

    Scoped to the caller because somebody else's wiki is not an answer to "give me a
    wiki of this repository" — under their ACL the caller may not even be able to
    read it.
    """
    from app.models.kind import Kind

    row = (
        db.query(WikiProject.kind_id)
        .join(Kind, Kind.id == WikiProject.kind_id)
        .filter(
            WikiProject.source_url == source.source_url,
            WikiProject.kind_id > 0,
            Kind.user_id == owner_id,
            Kind.is_active.is_(True),
        )
        .first()
    )
    return row[0] if row else None


@dataclass(frozen=True)
class ExistingWiki:
    """A wiki of this repository that somebody has already built."""

    id: int
    name: str
    owner_name: str
    # Whether the caller can already open it. False means the useful action is to
    # ask its owner for a share, which is why the owner is named at all.
    accessible: bool


def existing_wikis_for(
    db: Session, source_url: str, *, viewer_id: int
) -> list[ExistingWiki]:
    """Wikis already built from this repository, whoever owns them.

    Shown before creating another so that somebody can ask for a share instead of
    paying for a second generation — which needs the owner's name, not just a count.

    Listing wikis the caller cannot open is the point rather than a leak to weigh:
    the caller has demonstrated they can read the repository, and the disclosure is
    that a colleague documented it. Names of accessible wikis come with an id so the
    client can link straight to them.
    """
    from app.models.kind import Kind
    from app.models.user import User
    from app.services.knowledge.knowledge_service import KnowledgeService

    rows = (
        db.query(Kind, User.user_name)
        .join(WikiProject, WikiProject.kind_id == Kind.id)
        .outerjoin(User, User.id == Kind.user_id)
        .filter(
            WikiProject.source_url == source_url,
            WikiProject.kind_id > 0,
            Kind.is_active.is_(True),
        )
        .order_by(Kind.created_at.asc())
        .all()
    )

    visible = {kind.id for kind in KnowledgeService.list_knowledge_bases(db, viewer_id)}
    return [
        ExistingWiki(
            id=kind.id,
            name=(kind.json or {}).get("spec", {}).get("name") or kind.name,
            owner_name=owner_name or "",
            accessible=kind.id in visible,
        )
        for kind, owner_name in rows
    ]


def project_id_of(db: Session, kind_id: int) -> int:
    """The registry row a wiki's versions belong to.

    ``wiki_generations.project_id`` is a real foreign key, so a version cannot be
    written without one. Missing means the wiki was created before it had a registry
    row, which is a broken state rather than a state to write around — the caller
    should say so rather than insert a zero the database will reject anyway.
    """
    row = (
        db.query(WikiProject.id)
        .filter(WikiProject.kind_id == kind_id)
        .order_by(WikiProject.id.asc())
        .first()
    )
    return int(row[0]) if row else 0


def forget_repository(db: Session, kind_id: int) -> int:
    """Remove a wiki's registry rows, its versions and their contents.

    ``wiki_projects.kind_id`` is a plain column, not a foreign key into ``kinds``, so
    deleting the knowledge base does not reach it. Left behind, the row keeps every
    version and page of generated text alive while nothing can query them any more —
    invisible rather than harmless.

    **Deleted explicitly, in dependency order, rather than left to the cascade.** The
    ``ON DELETE CASCADE`` on these tables would do it, but relying on it means the
    behaviour depends on DDL that can differ between deployments, and SQLite does not
    enforce foreign keys at all — so a test suite could not tell the difference
    between this working and not existing. The cascade stays as a backstop; nothing
    reaches it.

    Returns:
        How many registry rows were removed.
    """
    project_ids = [
        row[0]
        for row in db.query(WikiProject.id).filter(WikiProject.kind_id == kind_id).all()
    ]
    if not project_ids:
        return 0

    from app.models.wiki import WikiContent, WikiGeneration

    generation_ids = [
        row[0]
        for row in db.query(WikiGeneration.id)
        .filter(WikiGeneration.project_id.in_(project_ids))
        .all()
    ]
    if generation_ids:
        db.query(WikiContent).filter(
            WikiContent.generation_id.in_(generation_ids)
        ).delete(synchronize_session=False)
        db.query(WikiGeneration).filter(WikiGeneration.id.in_(generation_ids)).delete(
            synchronize_session=False
        )

    db.query(WikiProject).filter(WikiProject.id.in_(project_ids)).delete(
        synchronize_session=False
    )
    logger.info(
        "[code_wiki] removed %s registry row(s) and %s version(s) for kb %s",
        len(project_ids),
        len(generation_ids),
        kind_id,
    )
    return len(project_ids)
