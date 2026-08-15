# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Driving a code wiki run from a knowledge base to an agent and back.

Everything either side of this module already exists and is tested on its own: the
version store decides what a run may do, the prompts say what the agent must produce,
and the publisher turns a finished version into knowledge base content. What was
missing is the part that actually starts one — resolving the repository, choosing the
mode, writing the instructions and handing them to a Task.

Two ordering decisions here are deliberate:

**The generation is committed before the task is created.** A crash between the two
then leaves a run with no task, which the staleness sweep reclaims after six hours. The
alternative ordering — task first — leaves a task with no run to report into, which
nothing reclaims and which would write its pages into a version that does not exist.

**A task that cannot be created fails the run immediately** rather than leaving it
RUNNING for the sweep to find. A wiki that refuses to regenerate for six hours because
of a misconfigured team is a much worse failure than one that says so at once.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional, Sequence

from sqlalchemy.orm import Session

from app.core.wiki_config import wiki_settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.models.wiki import WikiGeneration, WikiGenerationStatus
from app.schemas.knowledge import KnowledgeBaseType, validated_model_ref
from app.schemas.task import TaskCreate
from app.services.knowledge import KnowledgeService
from app.services.knowledge.code_wiki.generation import (
    SOURCE_COMMIT_KEY,
    FailureCode,
    GenerationInFlight,
    finish_generation,
    published_commit,
    record_failure_reason,
    start_generation,
)
from app.services.knowledge.code_wiki.prompts import WikiRunContext, build_prompt
from app.services.knowledge.code_wiki.publisher import (
    PublishResult,
    publish_generation,
    published_generation_id,
    read_version_pages,
)
from app.services.knowledge.code_wiki.repo_state import read_repository_state
from app.services.knowledge.code_wiki.run_mode import ChangedPath, RunMode
from app.services.knowledge.code_wiki.side_effects import build_projection_side_effects
from app.services.knowledge.code_wiki.source import SourceRepository

logger = logging.getLogger(__name__)

# What the model is told to write in, keyed by the configured language code. The
# prompt states this in prose, so it needs a language name rather than a code.
_LANGUAGE_NAMES = {"en": "English", "zh": "Chinese (Simplified)"}


class CodeWikiRunError(RuntimeError):
    """Raised when a run cannot be set up. The message is shown to the caller."""


@dataclass(frozen=True)
class StartedRun:
    """The outcome of asking a code wiki to regenerate."""

    generation: Optional[WikiGeneration]
    reason: str
    mode: str = ""
    task_id: int = 0

    @property
    def started(self) -> bool:
        return self.generation is not None


def source_of(knowledge_base: Kind) -> SourceRepository:
    """Read the repository a code wiki is bound to.

    Raises:
        CodeWikiRunError: If this knowledge base is not a code wiki, or is one with no
            usable repository recorded — which would otherwise surface much later as a
            task cloning an empty URL.
    """
    spec = (knowledge_base.json or {}).get("spec", {})
    if spec.get("kbType") != KnowledgeBaseType.CODE_WIKI.value:
        raise CodeWikiRunError("This knowledge base is not a code wiki")

    source = SourceRepository.from_spec(spec.get("source"))
    if source is None or not source.source_url or not source.project_name:
        raise CodeWikiRunError(
            "This code wiki has no source repository recorded and cannot be generated"
        )
    return source


def _project_id(db: Session, knowledge_base: Kind) -> int:
    """The registry row this wiki's versions belong to."""
    from app.services.knowledge.code_wiki.registry import project_id_of

    project_id = project_id_of(db, knowledge_base.id)
    if not project_id:
        raise CodeWikiRunError(
            "This code wiki has no repository registry row, so no version can be "
            "recorded for it. It was created before one was written."
        )
    return project_id


def _language_of(knowledge_base: Kind) -> str:
    """What the pages of this wiki are written in.

    The wiki's own choice, made when it was created. Falling back to the deployment
    default covers wikis created before the field existed, so their pages keep being
    written in the language they already are.
    """
    configured = (knowledge_base.json or {}).get("spec", {}).get("language")
    code = (configured or wiki_settings.DEFAULT_LANGUAGE or "en").lower()
    return _LANGUAGE_NAMES.get(code, "English")


def start_run(
    db: Session,
    *,
    knowledge_base: Kind,
    user: User,
    head_commit: str = "",
    changed_paths: Optional[Sequence[ChangedPath]] = None,
    total_source_files: Optional[int] = None,
    force_full: bool = False,
) -> StartedRun:
    """Start a run for ``knowledge_base`` and hand its instructions to a task.

    Args:
        db: Session.
        knowledge_base: The code wiki to regenerate.
        user: Identity the run is attributed to.
        head_commit: Commit the repository is at now. When empty it is read from the
            provider, and only if that also fails is the extent of the change taken
            as unknown — which costs a full rebuild.
        changed_paths: Diff since the published commit. ``None`` asks for it to be
            read from the provider alongside the commit.
        total_source_files: Repository size, used by the change-ratio threshold.
        force_full: Whether an explicit caller requested a fresh full rebuild.

    Returns:
        The started run, or a reason why none was needed.

    Raises:
        CodeWikiRunError: If the wiki cannot be generated, or a run is already going.
        GenerationInFlight: Propagated from the version store.
    """
    source = source_of(knowledge_base)
    team, task_user = _resolve_execution_context(db, knowledge_base, user)

    previous_commit = published_commit(db, knowledge_base)
    # Read on every run, including the first.
    #
    # This used to be skipped when nothing was published, on the grounds that a first
    # run rebuilds everything anyway and the agent reports the commit at the end. It
    # does not always report one — and a version published without a commit leaves the
    # next run with nothing to compare against, so that one also rebuilds everything
    # and also publishes without a commit. A wiki that misses it once never does an
    # incremental run again.
    #
    # Pinning it here costs a round trip and cannot fail the run: every read is
    # best-effort and answers with an empty state, so a slow or unreachable provider
    # leaves this exactly where the skip left it. The agent may still report a commit
    # when it finishes, which overwrites this one — it documented what it actually
    # checked out, and this is what the repository said when the run was created.
    if not head_commit:
        # Read as the user that will clone the repository, not the one who asked. On
        # a schedule there is no asker, and a token that cannot read the repository
        # would answer for a run that is about to fail at checkout anyway.
        state = read_repository_state(
            db,
            user_id=task_user.id,
            source=source,
            since_commit=previous_commit,
        )
        head_commit = state.head_commit
        if changed_paths is None:
            changed_paths = state.changed_paths

    started = start_generation(
        db,
        knowledge_base=knowledge_base,
        # The account that runs the task, not the one that asked: it is the identity
        # the agent authenticates as, so anything scoped to "this run's owner" has to
        # agree with it, and it is the account that owns the knowledge base being
        # published into.
        user=task_user,
        head_commit=head_commit,
        changed_paths=changed_paths,
        total_source_files=total_source_files,
        force_full=force_full,
        # A real foreign key on wiki_generations. Resolved here rather than defaulted
        # to zero: MySQL rejects the insert outright, and SQLite does not enforce it,
        # so a zero passes every test and fails every deployment.
        project_id=_project_id(db, knowledge_base),
        team_id=team.id,
    )
    if not started.started:
        return StartedRun(
            generation=None, reason=started.decision.reason, mode=started.decision.mode
        )

    generation = started.generation
    full = RunMode(started.decision.mode) is RunMode.FULL
    prompt = build_prompt(
        WikiRunContext(
            project_name=source.project_name,
            generation_id=generation.id,
            head_commit=head_commit,
            # The wiki's own choice, made when it was created. Falling back to the
            # deployment default covers wikis created before the field existed, so
            # their pages keep being written in the language they already are.
            language=_language_of(knowledge_base),
            previous_commit=previous_commit,
            changed_paths=[change.path for change in changed_paths or ()],
            existing_pages=[
                page.path for page in read_version_pages(db, generation.id)
            ],
        ),
        full=full,
    )

    # Committed before the task exists, so that a task always has a version to report
    # into. See the module docstring for why the reverse ordering is worse.
    db.commit()

    task_id = _create_task(
        db,
        source=source,
        team_id=team.id,
        task_user=task_user,
        prompt=prompt,
        generation=generation,
        listed=_shows_generation_task(knowledge_base),
        model_ref=_execution_model_of(knowledge_base),
    )

    generation.task_id = task_id
    db.commit()
    logger.info(
        "[code_wiki] generation %s for kb %s running under task %s",
        generation.id,
        knowledge_base.id,
        task_id,
    )
    return StartedRun(
        generation=generation,
        reason=started.decision.reason,
        mode=started.decision.mode,
        task_id=task_id,
    )


def finish_run(
    db: Session,
    *,
    generation: WikiGeneration,
    succeeded: bool,
    error_message: str = "",
    failure_code: str = "",
    head_commit: str = "",
) -> Optional[PublishResult]:
    """Conclude a run the agent has reported on, and publish it if it succeeded.

    Args:
        db: Session.
        generation: The run being concluded.
        succeeded: Whether the agent reported success.
        error_message: Why it failed, when it did.
        head_commit: Commit the agent actually documented. Recorded over whatever the
            run started with, because the agent read the working tree and the trigger
            only knew what it was told — and this value is what the next run's mode
            decision compares against.

    Returns:
        The publish outcome, or ``None`` when the run failed or was not publishable.
    """
    knowledge_base = _knowledge_base_of(db, generation)
    if knowledge_base is None:
        raise CodeWikiRunError(
            f"generation {generation.id} has no knowledge base to publish into"
        )

    user = db.get(User, generation.user_id)
    if user is None:
        raise CodeWikiRunError(
            f"generation {generation.id} has no user to publish as "
            f"(user {generation.user_id})"
        )

    if head_commit:
        snapshot = dict(generation.source_snapshot or {})
        snapshot[SOURCE_COMMIT_KEY] = head_commit
        generation.source_snapshot = snapshot
        db.flush()

    return finish_generation(
        db,
        knowledge_base=knowledge_base,
        generation=generation,
        user=user,
        effects=build_projection_side_effects(
            db, knowledge_base=knowledge_base, user=user
        ),
        succeeded=succeeded,
        error_message=error_message,
        failure_code=failure_code,
    )


def is_code_wiki_generation(db: Session, generation: WikiGeneration) -> bool:
    """Whether this run belongs to a code wiki rather than the legacy wiki path."""
    return _knowledge_base_of(db, generation) is not None


def _knowledge_base_of(db: Session, generation: WikiGeneration) -> Optional[Kind]:
    """The code wiki a run belongs to, or ``None`` for a legacy generation."""
    if not generation.kind_id:
        return None
    knowledge_base = db.get(Kind, generation.kind_id)
    if knowledge_base is None or knowledge_base.kind != "KnowledgeBase":
        return None
    return knowledge_base


def _resolve_execution_context(
    db: Session, knowledge_base: Kind, user: User
) -> tuple[Kind, User]:
    """Find the team that runs code wikis, and the user it runs as.

    **The run executes as the knowledge base's owner, not as whoever triggered it.**
    It said so and did the other thing: it took the caller. Anyone the wiki is shared
    with who has write access to the repository may trigger a run, and doing so made
    them the identity that clones it, owns the version, and owns every page projected
    out of it. A member with no credentials for that host failed at checkout on
    somebody else's wiki, and the pages a successful run wrote changed hands.

    The owner is the right identity because the wiki is theirs: an expired token
    fails their own wiki and is attributable to them, where a shared account's expiry
    would fail everybody's at once.

    The team, by contrast, comes from configuration rather than from the request: it
    carries the prompt and the tools the agent gets, so letting the caller choose it
    would let them choose those.
    """
    from app.services.adapters.team_kinds import team_kinds_service

    task_user = db.get(User, knowledge_base.user_id)
    if task_user is None:
        raise CodeWikiRunError(
            f"Code wiki {knowledge_base.id} has no owner to execute its generation"
        )
    if not task_user.is_active:
        raise CodeWikiRunError(
            f"Code wiki {knowledge_base.id} has no active owner to execute its generation"
        )
    team_name = wiki_settings.CODE_WIKI_TEAM_NAME
    if not team_name:
        raise CodeWikiRunError(
            "WIKI_CODE_WIKI_TEAM_NAME is not configured, so there is no team to run "
            "the wiki agent"
        )

    team = team_kinds_service.get_team_by_name_and_namespace(
        db=db,
        team_name=team_name,
        team_namespace="default",
        user_id=task_user.id,
    )
    if not team:
        raise CodeWikiRunError(
            f"Code wiki team '{team_name}' was not found for user {task_user.id}. "
            "Check WIKI_CODE_WIKI_TEAM_NAME and that the default resources are loaded."
        )
    return team, task_user


SHOW_GENERATION_TASK_KEY = "showGenerationTask"
EXECUTION_MODEL_REF_KEY = "executionModelRef"

# Where a task goes when it should not be listed as a conversation. The listing query
# excludes this namespace by name; task lookup by id does not, which is what makes a
# hidden run still reachable from the wiki's history.
HIDDEN_TASK_NAMESPACE = "system"


def _shows_generation_task(knowledge_base: Kind) -> bool:
    """Whether this wiki's runs belong in the owner's conversation list.

    Off unless asked for. A wiki regenerates on its own, so its runs are work the
    user did not start a conversation to do, and listing them buries the
    conversations they did start. The wiki's run history shows them either way and
    links to the task by id, so hidden is not lost.
    """
    spec = (knowledge_base.json or {}).get("spec", {})
    return bool(spec.get(SHOW_GENERATION_TASK_KEY, False))


def _execution_model_of(knowledge_base: Kind) -> Optional[Dict[str, str]]:
    """The model this wiki generates with, or None to use the team's own model.

    Required when creating a wiki, so None here means a wiki created before the
    field existed. Those keep running on whatever model their team's bot binds,
    which is what they have always run on.

    A stored value is re-checked rather than trusted: the request schema rejects a
    reference that names nothing, but rows written before it did are still in the
    table. Anything unusable degrades to the same team fallback, because a half
    applied override -- a task pinned to a model that does not resolve -- fails the
    whole run, while the fallback is a model that works.
    """
    spec = (knowledge_base.json or {}).get("spec", {})
    model_ref = spec.get(EXECUTION_MODEL_REF_KEY)
    if not isinstance(model_ref, dict):
        return None
    try:
        return validated_model_ref(model_ref)
    except ValueError as error:
        logger.warning(
            "[code_wiki] kb %s has an unusable %s (%s); running on the team's model",
            knowledge_base.id,
            EXECUTION_MODEL_REF_KEY,
            error,
        )
        return None


def _create_task(
    db: Session,
    *,
    source: SourceRepository,
    team_id: int,
    task_user: User,
    prompt: str,
    generation: WikiGeneration,
    listed: bool = False,
    model_ref: Optional[Dict[str, str]] = None,
) -> int:
    """Create the task that runs the agent, failing the run if it cannot be."""
    from app.services.adapters.task_kinds import task_kinds_service

    try:
        task_id = task_kinds_service.create_task_id(db, task_user.id)
        task_kinds_service.create_task_or_append(
            db=db,
            obj_in=TaskCreate(
                title=f"Code wiki: {source.project_name}",
                team_id=team_id,
                git_url=source.source_url,
                git_repo=source.project_name,
                git_repo_id=0,
                git_domain=source.source_domain,
                # Empty means the repository's default branch, resolved at clone time,
                # so a wiki always documents whatever that branch currently is.
                branch_name="",
                prompt=prompt,
                type="online",
                task_type="code",
                auto_delete_executor="false",
                source="code_wiki",
                # Left unset for wikis created before the field existed, which lets
                # the team's bot supply the model as it always has. TaskCreate turns
                # a model_id into an override on its own.
                model_id=(model_ref or {}).get("name"),
                force_override_bot_model_type=(model_ref or {}).get("type"),
            ),
            user=task_user,
            task_id=task_id,
            # Not part of the request body it builds: "hidden from the conversation
            # list" is something this run decides about its own task, not something
            # a client may ask for.
            namespace=("default" if listed else HIDDEN_TASK_NAMESPACE),
        )
        return task_id
    except Exception as exc:
        logger.error(
            "[code_wiki] could not create a task for generation %s: %s",
            generation.id,
            exc,
        )
        _fail_without_a_task(db, generation, exc)
        raise CodeWikiRunError(f"Could not start the wiki task: {exc}") from exc


def _fail_without_a_task(
    db: Session, generation: WikiGeneration, exc: Exception
) -> None:
    """Mark a run failed when nothing will ever report on it.

    Left RUNNING it would block the wiki until the staleness sweep, which is hours of
    a wiki refusing to regenerate over a configuration error visible right now.
    """
    db.rollback()
    live = db.get(WikiGeneration, generation.id)
    if live is None:
        return
    live.status = WikiGenerationStatus.FAILED
    live.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    record_failure_reason(live, str(exc), code=FailureCode.TASK_NOT_CREATED)
    db.commit()


def republish_generation(
    db: Session, *, knowledge_base: Kind, generation_id: int
) -> PublishResult:
    """Make an earlier version the one readers see again.

    The publish gate exists because a run can go wrong; this exists because the gate
    is advisory, so one that does go wrong now reaches readers. Everything a run
    wrote is retained until retention collects it, and until this there was no way to
    reach any of it — the pointer only ever moved forward.

    It goes through the same projection as any other publish, which is the point:
    there is one path that decides what a knowledge base holds. That also means it
    restores content and structure but **not identity**. The pages deleted on the way
    here took their document ids with them, and this adds them back as new documents,
    so anything that cited one still points at nothing.

    Raises:
        CodeWikiRunError: If the version does not belong to this wiki, or never
            finished, or is already the one published.
    """
    generation = db.get(WikiGeneration, generation_id)
    if generation is None or generation.kind_id != knowledge_base.id:
        raise CodeWikiRunError(f"Version {generation_id} does not belong to this wiki")

    if generation.status != WikiGenerationStatus.COMPLETED:
        raise CodeWikiRunError(
            f"Version {generation_id} is {generation.status}, so it holds no result "
            "to publish"
        )

    if published_generation_id(knowledge_base) == generation.id:
        raise CodeWikiRunError(f"Version {generation_id} is already published")

    owner = db.get(User, knowledge_base.user_id)
    if owner is None:
        raise CodeWikiRunError(
            f"Code wiki {knowledge_base.id} has no owner to publish its version"
        )

    result = publish_generation(
        db,
        knowledge_base=knowledge_base,
        generation=generation,
        user_id=owner.id,
        effects=build_projection_side_effects(
            db, knowledge_base=knowledge_base, user=owner
        ),
    )
    logger.info(
        "[code_wiki] republished generation %s into kb %s: published=%s",
        generation.id,
        knowledge_base.id,
        result.published,
    )
    return result


def start_first_run(user_id: int, knowledge_base_id: int) -> None:
    """Begin generating the wiki that was just created.

    Without this a new wiki is empty until somebody finds the regenerate button,
    which is not a flow anyone would guess.

    Runs after the response, on its own session: the request's session is closed by
    then, and reading the repository's HEAD can take the full connect timeout, which
    is not something the caller should wait through. Failures are logged rather than
    raised — the knowledge base is already saved, the reader shows an empty state,
    and its own button starts a run.
    """
    db = SessionLocal()
    try:
        knowledge_base = KnowledgeService._get_knowledge_base_record(
            db, knowledge_base_id
        )
        user = db.query(User).filter(User.id == user_id).first()
        if knowledge_base is None or user is None:  # pragma: no cover - just committed
            return
        start_run(db, knowledge_base=knowledge_base, user=user)
    except (CodeWikiRunError, GenerationInFlight) as e:
        logger.warning(
            "[code_wiki] first run not started for kb %s: %s", knowledge_base_id, e
        )
    except Exception:  # pragma: no cover - defensive
        db.rollback()
        logger.exception(
            "[code_wiki] first run not started for kb %s", knowledge_base_id
        )
    finally:
        db.close()
