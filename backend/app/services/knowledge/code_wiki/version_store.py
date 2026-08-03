# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The version store behind a code wiki.

A generation run writes here, not into the knowledge base. The knowledge base is a
projection of whichever version is published, so everything a run does — including
crashing halfway through — stays invisible until a complete version passes its publish
gate.

That containment is the point: it puts the atomicity boundary around a deterministic
projection measured in seconds instead of around an LLM run measured in hours.

Three invariants hold here:

- **A version is a complete snapshot.** An incremental run is seeded from the
  published version and revises it in place, so the projection can always treat a
  version as the whole truth and compute orphans as a plain set difference.
- **Seeding is the server's job.** The agent is told what changed and what pages
  exist, but is never responsible for carrying unchanged pages forward.
- **The published version is never collected.** Retention would otherwise eat the
  rollback baseline exactly when it is needed most.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

from sqlalchemy import func, insert, literal, select
from sqlalchemy.orm import Session

from app.models.wiki import WikiContent, WikiGeneration, WikiGenerationStatus
from app.services.knowledge.code_wiki.page_path import (
    collation_key,
    normalize_page_path,
)

logger = logging.getLogger(__name__)

# Key under which a page's stable path lives in ``WikiContent.ext``.
PATH_EXT_KEY = "path"

# How long a run may sit in flight before it is treated as abandoned. Generous, because
# a large repository legitimately takes a long time; the cost of being wrong is one
# duplicated run, whereas never expiring costs a wiki that can never be regenerated
# again — the lock below would refuse every later run forever.
STALE_RUN_AFTER_HOURS = 6.0

IN_FLIGHT_STATUSES = (
    WikiGenerationStatus.PENDING,
    WikiGenerationStatus.RUNNING,
)

# Retention defaults. Successful versions are the rollback material; failed ones are
# kept only long enough to be looked at.
DEFAULT_KEEP_SUCCESSFUL = 10
DEFAULT_MAX_AGE_DAYS = 90
DEFAULT_FAILED_RETENTION_DAYS = 7


def _utcnow() -> datetime:
    """Return a timezone-naive UTC timestamp, matching the wiki tables."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_naive_utc(value: Optional[datetime]) -> datetime:
    """Normalize a caller-supplied instant to the naive UTC the wiki tables store.

    An aware value is converted before its offset is dropped. Dropping it outright
    would shift the instant by that offset, and both callers compare the result
    against stored timestamps to decide what to reclaim or delete.
    """
    if value is None:
        return _utcnow()
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


@dataclass(frozen=True)
class SeedOutcome:
    """What seeding did."""

    copied_pages: int
    skipped_reason: str = ""

    @property
    def seeded(self) -> bool:
        return not self.skipped_reason


def page_path_of(content: WikiContent) -> str:
    """Return the stable path recorded on a version entry, or an empty string."""
    ext = content.ext or {}
    return str(ext.get(PATH_EXT_KEY, "") or "")


def set_page_path(content: WikiContent, path: str) -> None:
    """Record a normalized path on a version entry."""
    ext = dict(content.ext or {})
    ext[PATH_EXT_KEY] = path
    content.ext = ext


def seed_from_published(
    db: Session,
    *,
    target_generation_id: int,
    published_generation_id: int,
) -> SeedOutcome:
    """Copy the published version's pages into a new generation.

    Runs before the agent starts, so an incremental run revises a complete snapshot
    rather than producing a partial one. A run that then fails leaves the seed as
    unreferenced rows under a failed generation, which retention collects.

    Idempotent: a generation that already holds pages is left alone, so a retried
    scheduling attempt cannot double the version.
    """
    if published_generation_id <= 0:
        return SeedOutcome(0, skipped_reason="no published version to seed from")

    if target_generation_id == published_generation_id:
        return SeedOutcome(0, skipped_reason="target is the published version")

    existing = (
        db.query(func.count(WikiContent.id))
        .filter(WikiContent.generation_id == target_generation_id)
        .scalar()
    )
    if existing:
        return SeedOutcome(0, skipped_reason="generation already holds pages")

    now = _utcnow()
    # parent_id is deliberately not carried over: it refers to row ids inside the
    # source generation, so copying it would point every seeded page at a row in a
    # different version. Hierarchy comes from the page path, which is copied intact.
    source = select(
        literal(target_generation_id),
        WikiContent.type,
        WikiContent.title,
        WikiContent.content,
        literal(0),
        WikiContent.ext,
        literal(now),
        literal(now),
    ).where(WikiContent.generation_id == published_generation_id)

    db.execute(
        insert(WikiContent).from_select(
            [
                "generation_id",
                "type",
                "title",
                "content",
                "parent_id",
                "ext",
                "created_at",
                "updated_at",
            ],
            source,
        )
    )
    db.flush()

    copied = (
        db.query(func.count(WikiContent.id))
        .filter(WikiContent.generation_id == target_generation_id)
        .scalar()
        or 0
    )
    logger.info(
        "[code_wiki] seeded generation %s with %s pages from %s",
        target_generation_id,
        copied,
        published_generation_id,
    )
    return SeedOutcome(copied)


def remove_page(db: Session, *, generation_id: int, path: str) -> bool:
    """Drop a page from an in-flight version at the agent's request.

    Only the agent knows which page covered a module that no longer exists: phase one
    records no provenance, so the server sees changed file paths but cannot infer the
    page they belong to. The risk this creates is contained rather than avoided — the
    removal lands in an unpublished version, the previous version still has the page,
    and the publish gate checks how far the page count dropped.

    Returns:
        Whether a page was removed.
    """
    normalized = normalize_page_path(path)
    wanted = collation_key(normalized)

    for content in (
        db.query(WikiContent).filter(WikiContent.generation_id == generation_id).all()
    ):
        if collation_key(page_path_of(content)) == wanted:
            db.delete(content)
            db.flush()
            logger.info(
                "[code_wiki] removed page '%s' from generation %s",
                normalized,
                generation_id,
            )
            return True
    return False


def reclaim_stale_generations(
    db: Session,
    *,
    kind_id: int,
    now: Optional[datetime] = None,
    stale_after_hours: float = STALE_RUN_AFTER_HOURS,
) -> tuple[int, ...]:
    """Fail in-flight generations whose worker is gone.

    Without this a single lost worker blocks the wiki permanently: scheduling takes
    the generation row's lock and refuses to start while one is in flight, and a
    crashed run never leaves that state on its own.

    Returns:
        Ids of the generations that were failed.
    """
    cutoff = _as_naive_utc(now) - timedelta(hours=stale_after_hours)

    stale: Sequence[WikiGeneration] = (
        db.query(WikiGeneration)
        .filter(
            WikiGeneration.kind_id == kind_id,
            WikiGeneration.status.in_(IN_FLIGHT_STATUSES),
            WikiGeneration.updated_at < cutoff,
        )
        .all()
    )
    if not stale:
        return ()

    for generation in stale:
        generation.status = WikiGenerationStatus.FAILED
        generation.completed_at = _as_naive_utc(now)
    db.flush()

    reclaimed = tuple(generation.id for generation in stale)
    logger.warning(
        "[code_wiki] reclaimed %s abandoned generation(s) for kb %s: %s",
        len(reclaimed),
        kind_id,
        reclaimed,
    )
    return reclaimed


def apply_retention(
    db: Session,
    *,
    kind_id: int,
    published_generation_id: int,
    keep_successful: int = DEFAULT_KEEP_SUCCESSFUL,
    max_age_days: int = DEFAULT_MAX_AGE_DAYS,
    failed_retention_days: int = DEFAULT_FAILED_RETENTION_DAYS,
    now: Optional[datetime] = None,
) -> tuple[int, ...]:
    """Collect versions that are no longer worth keeping.

    The published version is exempt unconditionally. Two ordinary situations would
    otherwise collect it and leave the wiki with no version to roll back to: a run of
    consecutive failures pushing it out of the newest ``keep_successful``, and a
    repository quiet for long enough that every version ages out.

    Returns:
        Ids of the generations that were deleted.
    """
    reference = _as_naive_utc(now)
    doomed: list[int] = []

    successful = (
        db.query(WikiGeneration)
        .filter(
            WikiGeneration.kind_id == kind_id,
            WikiGeneration.status == WikiGenerationStatus.COMPLETED,
        )
        .order_by(WikiGeneration.created_at.desc(), WikiGeneration.id.desc())
        .all()
    )
    age_cutoff = reference - timedelta(days=max_age_days)
    for position, generation in enumerate(successful):
        if generation.id == published_generation_id:
            continue
        over_count = position >= keep_successful
        over_age = (generation.created_at or reference) < age_cutoff
        if over_count or over_age:
            doomed.append(generation.id)

    # Only terminal generations are collected. Excluding COMPLETED alone would sweep
    # up PENDING and RUNNING rows once they are old enough, deleting the pages of a
    # run still being written to. Reclamation normally fails an abandoned run long
    # before that, but retention must not depend on it having done so.
    failed_cutoff = reference - timedelta(days=failed_retention_days)
    unsuccessful = (
        db.query(WikiGeneration)
        .filter(
            WikiGeneration.kind_id == kind_id,
            WikiGeneration.status.notin_(
                [WikiGenerationStatus.COMPLETED, *IN_FLIGHT_STATUSES]
            ),
            WikiGeneration.created_at < failed_cutoff,
        )
        .all()
    )
    for generation in unsuccessful:
        if generation.id != published_generation_id:
            doomed.append(generation.id)

    if not doomed:
        return ()

    # Contents are removed explicitly rather than through the foreign key, because
    # SQLite does not enforce ON DELETE CASCADE unless asked to and the tests run there.
    db.query(WikiContent).filter(WikiContent.generation_id.in_(doomed)).delete(
        synchronize_session=False
    )
    db.query(WikiGeneration).filter(WikiGeneration.id.in_(doomed)).delete(
        synchronize_session=False
    )
    db.flush()

    logger.info(
        "[code_wiki] retention removed %s version(s) from kb %s",
        len(doomed),
        kind_id,
    )
    return tuple(doomed)
