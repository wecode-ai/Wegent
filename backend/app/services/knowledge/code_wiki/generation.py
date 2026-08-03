# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Starting and finishing a code wiki generation run.

This is the spine the rest of the pieces hang from. Everything else decides something
— which mode, which pages changed, whether a version may be published — but nothing
happens until a run is started and later concluded, and those are the two moments
where the invariants have to be enforced together:

**Starting** picks a mode, refuses to begin while another run is genuinely in flight,
reclaims one whose worker is gone, creates the version and seeds it. Seeding belongs
here rather than in the agent because a version that is not a complete snapshot would
be projected as one, and every page the run did not touch would read as an orphan.

**Finishing** records how the run ended and, only for a run that succeeded, offers the
version to the publish gate. A failed run leaves the published pointer where it was,
which is what makes the next scheduled run pick the work up again rather than skip it.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.models.wiki import WikiGeneration, WikiGenerationStatus, WikiGenerationType
from app.services.knowledge.code_wiki.projection import ProjectionSideEffects
from app.services.knowledge.code_wiki.publish_gate import PublishPolicy
from app.services.knowledge.code_wiki.publisher import (
    PublishResult,
    publish_generation,
    published_generation_id,
    read_version_pages,
)
from app.services.knowledge.code_wiki.run_mode import (
    ChangedPath,
    RunMode,
    RunModeDecision,
    RunModePolicy,
    decide_run_mode,
)
from app.services.knowledge.code_wiki.version_store import (
    STALE_RUN_AFTER_HOURS,
    _as_naive_utc,
    reclaim_stale_generations,
    seed_from_published,
)

logger = logging.getLogger(__name__)

SOURCE_COMMIT_KEY = "commit"


class GenerationInFlight(RuntimeError):
    """Raised when a run is already working on this wiki."""


@dataclass(frozen=True)
class StartedGeneration:
    """A run that has been created and is ready for the agent."""

    generation: Optional[WikiGeneration]
    decision: RunModeDecision
    seeded_pages: int = 0

    @property
    def started(self) -> bool:
        return self.generation is not None


def published_commit(db: Session, knowledge_base: Kind) -> str:
    """Commit the currently published wiki was generated from."""
    current = published_generation_id(knowledge_base)
    if not current:
        return ""
    generation = db.get(WikiGeneration, current)
    if generation is None:
        return ""
    return str((generation.source_snapshot or {}).get(SOURCE_COMMIT_KEY, "") or "")


def start_generation(
    db: Session,
    *,
    knowledge_base: Kind,
    user: User,
    head_commit: str,
    changed_paths: Optional[Sequence[ChangedPath]] = None,
    total_source_files: Optional[int] = None,
    project_id: int = 0,
    team_id: int = 0,
    task_id: int = 0,
    policy: Optional[RunModePolicy] = None,
    now: Optional[datetime] = None,
) -> StartedGeneration:
    """Begin a run, unless there is nothing to do or one is already going.

    Args:
        db: Session.
        knowledge_base: The code wiki.
        user: Identity the run executes under.
        head_commit: Repository HEAD the run would document.
        changed_paths: Diff since the published commit, or ``None`` when unknown —
            in which case a full rebuild is chosen rather than a guess.
        total_source_files: Repository size, used by the change-ratio threshold.
        project_id: Registry row this version belongs to. A real foreign key, so a
            version cannot be written without one.
        team_id: Team the generation task belongs to.
        task_id: Task driving the run, when one exists yet.
        policy: Thresholds promoting an incremental run to a full one.
        now: Reference time, for tests.

    Returns:
        The started run, or a decision explaining why none was needed.

    Raises:
        GenerationInFlight: If a live run already owns this wiki.
    """
    reclaimed = reclaim_stale_generations(db, kind_id=knowledge_base.id, now=now)
    if reclaimed:
        logger.warning(
            "[code_wiki] kb %s had %s abandoned run(s) before starting",
            knowledge_base.id,
            len(reclaimed),
        )

    # Locked before the in-flight query, because that query locks only the rows it
    # returns. With no live run there are no rows, so two concurrent starts would
    # both find nothing and both insert — two agents documenting one repository, two
    # seeded versions, and whichever finishes last silently overwrites the other.
    # The knowledge base row always exists, so locking it serialises starts per wiki
    # without depending on gap-lock behaviour that the isolation level can turn off.
    db.query(Kind).filter(Kind.id == knowledge_base.id).with_for_update().first()

    in_flight = (
        db.query(WikiGeneration)
        .filter(
            WikiGeneration.kind_id == knowledge_base.id,
            WikiGeneration.status.in_(
                [WikiGenerationStatus.PENDING, WikiGenerationStatus.RUNNING]
            ),
        )
        .with_for_update()
        .first()
    )
    if in_flight is not None:
        raise GenerationInFlight(
            f"generation {in_flight.id} is already running for this wiki"
        )

    last_commit = published_commit(db, knowledge_base)
    since_full = _runs_since_the_last_full(db, knowledge_base.id, now=now)
    decision = decide_run_mode(
        head_commit=head_commit,
        last_commit=last_commit or None,
        changed_paths=changed_paths,
        total_source_files=total_source_files,
        incrementals_since_full=since_full[0],
        days_since_full=since_full[1],
        # Passed only when given: the callee defaults it, and forwarding ``None``
        # would replace that default with nothing.
        **({"policy": policy} if policy is not None else {}),
    )

    if RunMode(decision.mode) == RunMode.SKIP:
        logger.info(
            "[code_wiki] kb %s needs no run: %s", knowledge_base.id, decision.reason
        )
        return StartedGeneration(generation=None, decision=decision)

    generation = WikiGeneration(
        project_id=project_id,
        kind_id=knowledge_base.id,
        user_id=user.id,
        task_id=task_id,
        team_id=team_id,
        generation_type=(
            WikiGenerationType.FULL
            if RunMode(decision.mode) == RunMode.FULL
            else WikiGenerationType.INCREMENTAL
        ),
        source_snapshot={SOURCE_COMMIT_KEY: head_commit},
        status=WikiGenerationStatus.RUNNING,
        ext={"runModeReason": decision.reason},
        completed_at=datetime(1970, 1, 1),
    )
    db.add(generation)
    db.flush()

    seeded = 0
    if decision.seeds_from_published:
        # Before the agent starts, so that it revises a complete snapshot rather than
        # producing a partial one the projection would read as a mass deletion.
        outcome = seed_from_published(
            db,
            target_generation_id=generation.id,
            published_generation_id=published_generation_id(knowledge_base),
        )
        seeded = outcome.copied_pages

    logger.info(
        "[code_wiki] started %s generation %s for kb %s (%s), seeded %s pages",
        decision.mode,
        generation.id,
        knowledge_base.id,
        decision.reason,
        seeded,
    )
    return StartedGeneration(
        generation=generation, decision=decision, seeded_pages=seeded
    )


def finish_generation(
    db: Session,
    *,
    knowledge_base: Kind,
    generation: WikiGeneration,
    user: User,
    effects: ProjectionSideEffects,
    succeeded: bool,
    error_message: str = "",
    policy: Optional[PublishPolicy] = None,
    now: Optional[datetime] = None,
) -> Optional[PublishResult]:
    """Conclude a run and, if it succeeded, offer its version for publishing.

    A failed run deliberately leaves the published pointer alone. The next scheduled
    run then still sees the repository as undocumented at its current commit and does
    the work again, rather than skipping changes nobody has written up.

    Returns:
        The publish outcome, or ``None`` when the run failed.
    """
    finished = (now or datetime.now(timezone.utc)).replace(tzinfo=None)

    if not succeeded:
        generation.status = WikiGenerationStatus.FAILED
        generation.completed_at = finished
        ext = dict(generation.ext or {})
        if error_message:
            ext["errorMessage"] = error_message
        generation.ext = ext
        db.commit()
        logger.warning(
            "[code_wiki] generation %s failed for kb %s: %s",
            generation.id,
            knowledge_base.id,
            error_message or "no reason given",
        )
        return None

    generation.status = WikiGenerationStatus.COMPLETED
    generation.completed_at = finished
    db.flush()

    return publish_generation(
        db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=user.id,
        effects=effects,
        policy=policy,
    )


def _runs_since_the_last_full(
    db: Session, kind_id: int, now: Optional[datetime] = None
) -> tuple[int, Optional[float]]:
    """How much has accumulated since this wiki was last rebuilt from scratch.

    Feeds the periodic-rebuild thresholds, which had the branches for this from the
    start and were never given the inputs — so they defaulted to "no drift yet" and
    the wiki was never rebuilt no matter how long it ran on increments.

    Returns:
        The number of completed incremental runs, and the age in days of the last
        full one — ``None`` when there has never been a full run to age.
    """
    latest_full = (
        db.query(WikiGeneration)
        .filter(
            WikiGeneration.kind_id == kind_id,
            WikiGeneration.generation_type == WikiGenerationType.FULL,
            WikiGeneration.status == WikiGenerationStatus.COMPLETED,
        )
        .order_by(WikiGeneration.completed_at.desc())
        .first()
    )
    if latest_full is None:
        return 0, None

    incrementals = (
        db.query(WikiGeneration)
        .filter(
            WikiGeneration.kind_id == kind_id,
            WikiGeneration.generation_type == WikiGenerationType.INCREMENTAL,
            WikiGeneration.status == WikiGenerationStatus.COMPLETED,
            WikiGeneration.completed_at > latest_full.completed_at,
        )
        .count()
    )
    reference = (now or datetime.now(timezone.utc)).replace(tzinfo=None)
    age_days = (reference - latest_full.completed_at).total_seconds() / 86400
    return incrementals, max(0.0, age_days)


def version_page_count(db: Session, generation_id: int) -> int:
    """How many pages a version holds, for status displays."""
    return len(read_version_pages(db, generation_id))


@dataclass(frozen=True)
class RunState:
    """What is happening to a wiki right now, as a reader needs to see it."""

    # "running" | "failed" | "completed" | "never"
    status: str
    generation_id: int = 0
    started_at: Optional[datetime] = None
    error_message: str = ""
    # A run whose worker has gone quiet for longer than the sweep tolerates. The next
    # trigger reclaims it and starts afresh, so the caller may act on it — which is
    # the whole reason this is reported rather than folded into "running".
    is_stale: bool = False


def current_run_state(
    db: Session, knowledge_base: Kind, *, now: Optional[datetime] = None
) -> RunState:
    """The state of this wiki's most recent run.

    Read rather than derived from the published pointer: a version can be running,
    or have failed, while a perfectly good earlier one is published. The pointer says
    what a reader sees; this says whether anything is being done about it.
    """
    latest = (
        db.query(WikiGeneration)
        .filter(WikiGeneration.kind_id == knowledge_base.id)
        .order_by(WikiGeneration.id.desc())
        .first()
    )
    if latest is None:
        return RunState(status="never")

    if latest.status == WikiGenerationStatus.RUNNING:
        moment = _as_naive_utc(now or datetime.now(timezone.utc))
        touched = latest.updated_at or latest.created_at
        stale = bool(
            touched and (moment - touched) > timedelta(hours=STALE_RUN_AFTER_HOURS)
        )
        return RunState(
            status="running",
            generation_id=latest.id,
            started_at=latest.created_at,
            is_stale=stale,
        )

    if latest.status == WikiGenerationStatus.COMPLETED:
        return RunState(
            status="completed", generation_id=latest.id, started_at=latest.created_at
        )

    return RunState(
        status="failed",
        generation_id=latest.id,
        started_at=latest.created_at,
        error_message=str((latest.ext or {}).get("error_message", "") or ""),
    )
