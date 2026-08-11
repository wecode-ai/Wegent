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
    apply_retention,
    reclaim_stale_generations,
    seed_from_published,
)

logger = logging.getLogger(__name__)

SOURCE_COMMIT_KEY = "commit"

# Why a run failed, reached only through the two helpers below.
#
# It was previously written as "errorMessage" by both failure paths and read back as
# "error_message", so every failure reported an empty reason: the reader was told the
# run had failed and nothing about why, which is the one moment the reason matters.
# Neither half was wrong on its own, which is why it survived — the fix is not the
# spelling but having a single place that decides it.
FAILURE_REASON_EXT_KEY = "errorMessage"


# A machine-readable name for the failures this server invents, beside the human
# text. The text of an invented reason is English written here, and it was being
# shown straight to readers next to translated UI, which reads as a bug rather than
# as a diagnostic. A client translates the codes it knows and falls back to the text.
#
# Absent means the reason came from outside -- the agent's own message, git's output,
# an exception -- and there is nothing to translate it into.
FAILURE_CODE_EXT_KEY = "failureCode"


class FailureCode:
    """Failures this server states in its own words."""

    #: The task reached a terminal state without the agent concluding its run.
    TASK_ENDED_WITHOUT_REPORT = "task_ended_without_report"
    #: No task could be created, so nothing was ever going to run.
    TASK_NOT_CREATED = "task_not_created"
    #: The worker stopped reporting and the run was reclaimed.
    WORKER_ABANDONED = "worker_abandoned"
    #: The version was written but the publish gate refused it.
    PUBLISH_REFUSED = "publish_refused"


def record_failure_reason(
    generation: WikiGeneration, reason: str, *, code: str = ""
) -> None:
    """Store why a run failed, replacing ``ext`` so SQLAlchemy sees the change.

    ``reason`` is detail worth showing verbatim; ``code`` names a failure the server
    invented and can be translated. A reclaimed run has a code and no detail, which
    is why an empty reason no longer means nothing is recorded.
    """
    if not reason and not code:
        return
    ext = dict(generation.ext or {})
    if reason:
        ext[FAILURE_REASON_EXT_KEY] = reason
    if code:
        ext[FAILURE_CODE_EXT_KEY] = code
    generation.ext = ext


def failure_reason(generation: WikiGeneration) -> str:
    """Why a run failed, or an empty string when it did not say."""
    return str((generation.ext or {}).get(FAILURE_REASON_EXT_KEY, "") or "")


def failure_code(generation: WikiGeneration) -> str:
    """Which server-stated failure this was, or empty when the reason came from
    outside and is only available as text."""
    return str((generation.ext or {}).get(FAILURE_CODE_EXT_KEY, "") or "")


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
    failure_code: str = "",
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
        record_failure_reason(generation, error_message, code=failure_code)
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

    result = publish_generation(
        db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=user.id,
        effects=effects,
        policy=policy,
    )

    if not result.published:
        # The status was set to COMPLETED above, before publishing was attempted,
        # because the gate refuses to consider a version that is not. A refused
        # version then kept it: the run reported as a success while the wiki was
        # unchanged, which is the opposite of what happened and the one case where a
        # reader most needs to be told.
        generation.status = WikiGenerationStatus.FAILED
        record_failure_reason(
            generation, result.reason, code=FailureCode.PUBLISH_REFUSED
        )
        db.commit()
        logger.warning(
            "[code_wiki] generation %s is not published, recording it as failed: %s",
            generation.id,
            result.reason,
        )

    _collect_old_versions(db, knowledge_base)
    return result


def _collect_old_versions(db: Session, knowledge_base: Kind) -> None:
    """Drop versions no longer worth keeping, now that a newer one exists.

    Publishing is when a version stops being the one readers see, so it is when the
    ones behind it become collectable. The policy has always been written; nothing
    ever called it, so wiki_generations and wiki_contents grew without bound — a
    wiki regenerating on a schedule keeps every page of every run it has ever made.

    Never raises. Retention is housekeeping: a wiki that has just been published
    successfully must not be reported as failed because old rows could not be tidied,
    and the next publish will collect them anyway.
    """
    try:
        apply_retention(
            db,
            kind_id=knowledge_base.id,
            published_generation_id=published_generation_id(knowledge_base),
        )
    except Exception:  # pragma: no cover - defensive
        logger.exception(
            "[code_wiki] could not apply retention to kb %s", knowledge_base.id
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
    failure_code: str = ""
    # A run whose worker has gone quiet for longer than the sweep tolerates. The next
    # trigger reclaims it and starts afresh, so the caller may act on it — which is
    # the whole reason this is reported rather than folded into "running".
    is_stale: bool = False


def reader_status(generation: WikiGeneration) -> str:
    """The stored status as a reader is told it: running, completed or failed.

    Five states are stored and three are reported. PENDING and CANCELLED both collapse
    into "failed" deliberately: neither produced a version, and a reader deciding
    whether to regenerate needs to know that, not which internal state stopped it.

    Shared by the status endpoint and the history rather than written out at each,
    because a reader who sees a run called "failed" in one place and "completed" in
    the other has no way to tell which to believe.
    """
    stored = generation.status
    value = str(stored.value if hasattr(stored, "value") else stored or "").upper()
    if value == WikiGenerationStatus.RUNNING.value:
        return "running"
    if value == WikiGenerationStatus.COMPLETED.value:
        return "completed"
    return "failed"


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

    reported = reader_status(latest)
    if reported == "running":
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

    if reported == "completed":
        return RunState(
            status="completed", generation_id=latest.id, started_at=latest.created_at
        )

    return RunState(
        status="failed",
        generation_id=latest.id,
        started_at=latest.created_at,
        error_message=failure_reason(latest),
        failure_code=failure_code(latest),
    )


@dataclass(frozen=True)
class RunRecord:
    """One past attempt, as a reader troubleshooting the wiki needs to see it."""

    generation_id: int
    status: str
    mode: str = ""
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    commit: str = ""
    error_message: str = ""
    failure_code: str = ""
    published: bool = False
    task_id: int = 0
    #: What became of the task that ran the agent, as the task itself records it.
    #: Empty when there was no task, or it is gone.
    task_status: str = ""


# Enough to cover the run that broke the wiki without turning this into an audit log.
RUN_HISTORY_LIMIT = 20


def run_history(
    db: Session, knowledge_base: Kind, *, limit: int = RUN_HISTORY_LIMIT
) -> list[RunRecord]:
    """This wiki's recent runs, newest first.

    Separate from ``current_run_state`` rather than an extension of it. That one is
    polled every few seconds while a run is going and must stay a single indexed row;
    this one is fetched when somebody opens the history and asks what went wrong.

    ``completed_at`` is reported as absent for a run still going, because the column's
    default is the epoch rather than NULL and a client would otherwise render 1970.

    The task's own outcome is reported alongside the version's. They are two facts
    about one run and they can honestly differ: an agent that submitted its pages and
    concluded the run leaves a published version behind even if its container then
    died, and the version is not wrong about that. Showing only the version made the
    two look as though they disagreed, with no way to see that there were two.
    """
    published = published_generation_id(knowledge_base)
    rows = (
        db.query(WikiGeneration)
        .filter(WikiGeneration.kind_id == knowledge_base.id)
        .order_by(WikiGeneration.id.desc())
        .limit(limit)
        .all()
    )
    task_states = _task_states(db, [int(row.task_id or 0) for row in rows])

    return [
        RunRecord(
            generation_id=row.id,
            status=reader_status(row),
            mode=str(
                row.generation_type.value
                if hasattr(row.generation_type, "value")
                else row.generation_type or ""
            ),
            started_at=row.created_at,
            completed_at=_finished_at(row),
            commit=str((row.source_snapshot or {}).get(SOURCE_COMMIT_KEY, "") or ""),
            error_message=failure_reason(row),
            failure_code=failure_code(row),
            published=bool(published) and row.id == published,
            task_id=int(row.task_id or 0),
            task_status=task_states.get(int(row.task_id or 0), ""),
        )
        for row in rows
    ]


def _task_states(db: Session, task_ids: Sequence[int]) -> dict[int, str]:
    """What became of each task, in one query for the whole page of history."""
    wanted = {task_id for task_id in task_ids if task_id}
    if not wanted:
        return {}

    # Through the store rather than a query of its own: task rows belong to that
    # layer, and a static check enforces it.
    from app.stores.tasks import task_store

    return {
        task.id: str(((task.json or {}).get("status") or {}).get("status") or "")
        for task in task_store.list_by_ids(db, task_ids=sorted(wanted))
    }


def _finished_at(generation: WikiGeneration) -> Optional[datetime]:
    """When a run ended, or ``None`` while it has not."""
    finished = generation.completed_at
    if finished is None or finished.year <= 1970:
        return None
    return finished
