# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for driving a run from a knowledge base to a task and back.

The pieces either side of the runner are covered on their own, so what is asserted
here is the wiring: that the agent gets instructions matching the mode the version
store chose, that a run which cannot get a task does not sit RUNNING and block the
wiki, and that the commit the agent reports is the one the next run compares against.
"""

from dataclasses import dataclass, field
from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.models.wiki import (
    WikiContent,
    WikiGeneration,
    WikiGenerationStatus,
    WikiProject,
)
from app.schemas.task import TaskCreate
from app.services.knowledge.code_wiki.generation import published_commit
from app.services.knowledge.code_wiki.publisher import published_generation_id
from app.services.knowledge.code_wiki.run_mode import ChangedPath
from app.services.knowledge.code_wiki.runner import (
    CodeWikiRunError,
    finish_run,
    is_code_wiki_generation,
    source_of,
    start_run,
)
from app.services.knowledge.code_wiki.version_store import set_page_path

HEAD = "aaaaaaa"
NEXT_HEAD = "bbbbbbb"

SOURCE = {
    "sourceType": "github",
    "sourceUrl": "https://github.com/wecode-ai/Wegent.git",
    "sourceDomain": "github.com",
    "projectName": "wecode-ai/Wegent",
}


@dataclass
class FakeTasks:
    """Stands in for the task service, capturing what the agent would be sent."""

    created: list[TaskCreate] = field(default_factory=list)
    # Captured separately because it is no longer part of the request body: whether a
    # task is listed as a conversation is this run's decision, not a field a client
    # could set.
    namespaces: list[str] = field(default_factory=list)
    next_id: int = 500
    fails: bool = False

    def create_task_id(self, db, user_id: int) -> int:
        self.next_id += 1
        return self.next_id

    def create_task_or_append(
        self, *, db, obj_in: TaskCreate, user, task_id, namespace="default"
    ):
        if self.fails:
            raise RuntimeError("no executor available")
        self.created.append(obj_in)
        self.namespaces.append(namespace)
        return {"id": task_id}

    @property
    def prompt(self) -> str:
        return self.created[-1].prompt


@pytest.fixture
def tasks(monkeypatch, test_db: Session, test_user: User) -> FakeTasks:
    """Replace team lookup and task creation, which reach outside this unit."""
    from app.services.adapters import task_kinds, team_kinds

    team = Kind(
        kind="Team",
        name="code-wiki-team",
        namespace="default",
        user_id=test_user.id,
        json={"spec": {"description": "code wiki"}},
        is_active=True,
    )
    test_db.add(team)
    test_db.flush()

    fake = FakeTasks()
    monkeypatch.setattr(
        team_kinds.team_kinds_service,
        "get_team_by_name_and_namespace",
        lambda **kwargs: team,
    )
    monkeypatch.setattr(
        task_kinds.task_kinds_service, "create_task_id", fake.create_task_id
    )
    monkeypatch.setattr(
        task_kinds.task_kinds_service,
        "create_task_or_append",
        fake.create_task_or_append,
    )
    return fake


@pytest.fixture
def knowledge_base(test_db: Session, test_user: User) -> Kind:
    kind = Kind(
        kind="KnowledgeBase",
        name="kb-runner",
        namespace="default",
        user_id=test_user.id,
        json={"spec": {"name": "wiki", "kbType": "code_wiki", "source": SOURCE}},
        is_active=True,
    )
    test_db.add(kind)
    test_db.flush()
    # Every version points at a registry row through a real foreign key, so a wiki
    # without one cannot record a run. MySQL rejects it; SQLite does not enforce the
    # constraint, which is how a hardcoded zero passed here and failed in production.
    test_db.add(
        WikiProject(
            project_name=SOURCE["projectName"],
            project_type="git",
            source_type=SOURCE["sourceType"],
            source_url=SOURCE["sourceUrl"],
            source_domain=SOURCE["sourceDomain"],
            kind_id=kind.id,
            is_active=True,
        )
    )
    test_db.flush()
    return kind


@dataclass
class FakeEffects:
    written: list[str] = field(default_factory=list)
    next_id: int = 8000

    def _write(self, *, filename: str, content: str) -> int:
        self.next_id += 1
        self.written.append(filename)
        return self.next_id


@pytest.fixture
def no_side_effects(monkeypatch) -> FakeEffects:
    """Publish without touching attachment storage, the index or the queue."""
    from app.services.knowledge.code_wiki import runner
    from app.services.knowledge.code_wiki.projection import ProjectionSideEffects

    fake = FakeEffects()
    monkeypatch.setattr(
        runner,
        "build_projection_side_effects",
        lambda db, *, knowledge_base, user: ProjectionSideEffects(
            write_attachment=fake._write,
            delete_attachment=lambda _: None,
            delete_rag_document=lambda _: None,
            enqueue_reindex=lambda _: None,
        ),
    )
    return fake


def _write_page(test_db: Session, generation: WikiGeneration, path: str):
    entry = WikiContent(
        generation_id=generation.id,
        type="chapter",
        title=path,
        content="body",
        parent_id=0,
    )
    set_page_path(entry, path)
    test_db.add(entry)
    test_db.flush()


# --- what the wiki is bound to ---------------------------------------------


def test_a_knowledge_base_that_is_not_a_code_wiki_cannot_be_generated(
    test_db: Session, test_user: User
):
    notebook = Kind(
        kind="KnowledgeBase",
        name="kb-notebook",
        namespace="default",
        user_id=test_user.id,
        json={"spec": {"name": "notes", "kbType": "notebook"}},
        is_active=True,
    )
    test_db.add(notebook)
    test_db.flush()

    with pytest.raises(CodeWikiRunError, match="not a code wiki"):
        source_of(notebook)


def test_a_code_wiki_with_no_repository_is_refused_before_a_task_exists(
    test_db: Session, test_user: User
):
    """Otherwise it surfaces much later as a task cloning an empty URL."""
    unbound = Kind(
        kind="KnowledgeBase",
        name="kb-unbound",
        namespace="default",
        user_id=test_user.id,
        json={"spec": {"name": "wiki", "kbType": "code_wiki"}},
        is_active=True,
    )
    test_db.add(unbound)
    test_db.flush()

    with pytest.raises(CodeWikiRunError, match="no source repository"):
        source_of(unbound)


# --- starting a run ---------------------------------------------------------


def test_a_first_run_sends_the_agent_a_task_for_the_bound_repository(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    started = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
    )

    assert started.started
    created = tasks.created[0]
    assert created.git_url == SOURCE["sourceUrl"]
    assert created.git_repo == SOURCE["projectName"]
    assert created.git_domain == SOURCE["sourceDomain"]
    assert created.source == "code_wiki"


def test_the_task_clones_the_default_branch(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """A pinned branch would document whatever it was at the day the wiki was made."""
    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    assert tasks.created[0].branch_name == ""


def test_the_run_is_reachable_from_the_task_it_created(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    started = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
    )

    assert started.generation.task_id == started.task_id
    assert started.task_id > 0


def test_a_first_run_gets_the_full_rebuild_instructions(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    assert "begins empty" in tasks.prompt
    assert "copy of the published" not in tasks.prompt


def test_the_prompt_carries_the_generation_the_agent_must_write_into(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    started = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
    )

    assert str(started.generation.id) in tasks.prompt


def test_an_unchanged_repository_starts_no_task_at_all(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects: FakeEffects,
):
    _publish_a_first_wiki(test_db, knowledge_base, test_user, tasks)

    started = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
    )

    assert not started.started
    assert started.mode == "skip"
    assert len(tasks.created) == 1


def test_an_incremental_run_tells_the_agent_which_pages_already_exist(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects: FakeEffects,
):
    """Without them the agent cannot tell an update from a new page."""
    _publish_a_first_wiki(test_db, knowledge_base, test_user, tasks)

    start_run(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=[ChangedPath("src/one.py", "M")],
    )

    assert "copy of the published" in tasks.prompt
    assert "architecture/backend" in tasks.prompt


def test_an_incremental_run_tells_the_agent_what_changed(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects: FakeEffects,
):
    _publish_a_first_wiki(test_db, knowledge_base, test_user, tasks)

    start_run(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=[ChangedPath("src/one.py", "M")],
    )

    assert "src/one.py" in tasks.prompt
    assert HEAD in tasks.prompt and NEXT_HEAD in tasks.prompt


def test_a_run_whose_task_cannot_be_created_does_not_block_the_wiki(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """Left RUNNING it would refuse to regenerate until the six-hour sweep."""
    tasks.fails = True

    with pytest.raises(CodeWikiRunError, match="Could not start the wiki task"):
        start_run(
            test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
        )

    generation = test_db.query(WikiGeneration).one()
    assert generation.status == WikiGenerationStatus.FAILED
    # The code says what happened, in a form a client can translate; the exception
    # text survives beside it, because that is the only part naming the cause.
    from app.services.knowledge.code_wiki.generation import FailureCode

    assert generation.ext["failureCode"] == FailureCode.TASK_NOT_CREATED
    assert "no executor available" in generation.ext["errorMessage"]

    tasks.fails = False
    retry = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
    )
    assert retry.started


# --- finishing a run --------------------------------------------------------


def _publish_a_first_wiki(test_db, knowledge_base, test_user, tasks) -> WikiGeneration:
    started = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
    )
    _write_page(test_db, started.generation, "index")
    _write_page(test_db, started.generation, "architecture/backend")
    finish_run(test_db, generation=started.generation, succeeded=True, head_commit=HEAD)
    return started.generation


def test_a_successful_run_publishes_into_the_knowledge_base(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects: FakeEffects,
):
    generation = _publish_a_first_wiki(test_db, knowledge_base, test_user, tasks)

    assert published_generation_id(knowledge_base) == generation.id


def test_the_commit_the_agent_reports_is_what_the_next_run_compares_against(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects: FakeEffects,
):
    """The trigger only knew what it was told; the agent read the working tree."""
    started = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=""
    )
    _write_page(test_db, started.generation, "index")

    finish_run(
        test_db, generation=started.generation, succeeded=True, head_commit=NEXT_HEAD
    )

    assert published_commit(test_db, knowledge_base) == NEXT_HEAD


def test_a_failed_run_publishes_nothing(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects: FakeEffects,
):
    first = _publish_a_first_wiki(test_db, knowledge_base, test_user, tasks)

    started = start_run(
        test_db,
        knowledge_base=knowledge_base,
        user=test_user,
        head_commit=NEXT_HEAD,
        changed_paths=[ChangedPath("src/one.py", "M")],
    )
    result = finish_run(
        test_db,
        generation=started.generation,
        succeeded=False,
        error_message="model timed out",
    )

    assert result is None
    assert published_generation_id(knowledge_base) == first.id


def test_a_run_belonging_to_no_knowledge_base_is_not_a_code_wiki_run(
    test_db: Session, test_user: User
):
    """The legacy wiki writes through the same API and must keep its own behaviour."""
    legacy = WikiGeneration(
        project_id=1,
        kind_id=0,
        user_id=test_user.id,
        task_id=0,
        team_id=1,
        generation_type="full",
        source_snapshot={},
        status=WikiGenerationStatus.RUNNING,
        completed_at=datetime(1970, 1, 1),
    )
    test_db.add(legacy)
    test_db.flush()

    assert not is_code_wiki_generation(test_db, legacy)


# --- resolving the repository's state when the caller did not supply it ------


def _repository_at(monkeypatch, head: str, changed=None):
    """Answer as the provider would, without reaching one."""
    from app.services.knowledge.code_wiki import runner
    from app.services.knowledge.code_wiki.repo_state import RepositoryState

    monkeypatch.setattr(
        runner,
        "read_repository_state",
        lambda db, *, user_id, source, since_commit: RepositoryState(
            head_commit=head, branch="main", changed_paths=changed
        ),
    )


def test_an_unchanged_repository_is_recognised_without_being_told(
    monkeypatch,
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects: FakeEffects,
):
    """The whole point of reading HEAD: a schedule over a quiet repository must
    cost one comparison, not a full pass through the model."""
    _publish_a_first_wiki(test_db, knowledge_base, test_user, tasks)
    _repository_at(monkeypatch, HEAD, changed=())

    started = start_run(test_db, knowledge_base=knowledge_base, user=test_user)

    assert not started.started
    assert started.mode == "skip"
    assert len(tasks.created) == 1


def test_a_changed_repository_is_updated_incrementally_without_being_told(
    monkeypatch,
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects: FakeEffects,
):
    _publish_a_first_wiki(test_db, knowledge_base, test_user, tasks)
    _repository_at(monkeypatch, NEXT_HEAD, changed=(ChangedPath("src/one.py", "M"),))

    started = start_run(test_db, knowledge_base=knowledge_base, user=test_user)

    assert started.mode == "incremental"
    assert "src/one.py" in tasks.prompt


def test_a_repository_that_cannot_be_read_falls_back_to_a_rebuild(
    monkeypatch,
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects: FakeEffects,
):
    """Expensive, and the only safe answer: an unknown diff might be anything."""
    _publish_a_first_wiki(test_db, knowledge_base, test_user, tasks)
    _repository_at(monkeypatch, "", changed=None)

    started = start_run(test_db, knowledge_base=knowledge_base, user=test_user)

    assert started.mode == "full"


def test_a_supplied_commit_is_not_second_guessed(
    monkeypatch,
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
):
    """A caller that knows the commit — a webhook, a test — must be believed."""
    from app.services.knowledge.code_wiki import runner

    def refuse(*args, **kwargs):
        raise AssertionError("the provider must not be consulted")

    monkeypatch.setattr(runner, "read_repository_state", refuse)

    started = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
    )

    assert started.started


def test_a_first_run_pins_the_commit_it_is_documenting(
    monkeypatch,
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
):
    """A first run reads the repository, and this test exists because it once did
    not.

    Skipping the read looked free: with nothing published the mode is full whatever
    the repository says, and the agent reports the commit when it finishes. But it
    does not always report one, and a version published without a commit leaves the
    next run with nothing to compare against — so that run is full too, and also
    publishes without a commit. A wiki that misses it once never runs incrementally
    again, which is the opposite of free.
    """
    from app.services.knowledge.code_wiki import runner
    from app.services.knowledge.code_wiki.repo_state import RepositoryState

    monkeypatch.setattr(
        runner,
        "read_repository_state",
        lambda *args, **kwargs: RepositoryState(head_commit="c0ffee1", branch="main"),
    )

    started = start_run(test_db, knowledge_base=knowledge_base, user=test_user)

    assert started.started
    assert started.mode == "full"
    assert started.generation.source_snapshot["commit"] == "c0ffee1"


def test_a_repository_that_cannot_be_read_still_starts_a_run(
    monkeypatch,
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
):
    """The read is what the skip was protecting against: a slow or unreachable
    provider, up to the whole connect timeout. It cannot fail the run — every read
    is best-effort and answers with an empty state — so this ends up exactly where
    the skip left it, with the agent free to report the commit itself.
    """
    from app.services.knowledge.code_wiki import runner
    from app.services.knowledge.code_wiki.repo_state import RepositoryState

    monkeypatch.setattr(
        runner, "read_repository_state", lambda *args, **kwargs: RepositoryState()
    )

    started = start_run(test_db, knowledge_base=knowledge_base, user=test_user)

    assert started.started
    assert started.generation.source_snapshot["commit"] == ""


def test_a_version_points_at_a_registry_row_that_exists(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """``wiki_generations.project_id`` is a real foreign key. A value no row carries
    is rejected outright by MySQL, and SQLite here does not enforce the constraint —
    so a hardcoded zero passed every test and failed every deployment, and no code
    wiki could ever record a run.
    """
    started = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
    )

    project_id = started.generation.project_id
    assert project_id
    assert test_db.get(WikiProject, project_id) is not None


def test_a_wiki_with_no_registry_row_says_so_rather_than_writing_a_zero(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """Writing a zero moves the failure to the database driver, where the message
    names a constraint rather than the wiki that is missing its row."""
    test_db.query(WikiProject).filter(WikiProject.kind_id == knowledge_base.id).delete()
    test_db.flush()

    with pytest.raises(CodeWikiRunError, match="registry row"):
        start_run(
            test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
        )


def test_deleting_a_wiki_takes_its_versions_with_it(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """wiki_projects.kind_id is a plain column, so deleting the knowledge base does
    not reach it. Left behind, the row keeps every version and page of generated text
    alive while nothing can query them any more — invisible rather than harmless.

    Deleted explicitly rather than by cascade, so this test means something on SQLite
    too, where foreign keys are not enforced.
    """
    from app.services.knowledge.code_wiki.registry import forget_repository

    started = start_run(
        test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD
    )
    generation_id = started.generation.id

    removed = forget_repository(test_db, knowledge_base.id)
    test_db.flush()

    assert removed == 1
    assert (
        test_db.query(WikiProject)
        .filter(WikiProject.kind_id == knowledge_base.id)
        .count()
        == 0
    )
    # Counted rather than fetched by id: a bulk delete leaves the session's identity
    # map untouched, so db.get would answer from memory. Asserted here rather than
    # left to ON DELETE CASCADE, which SQLite does not enforce — a test relying on it
    # could not tell this working apart from it not existing.
    assert (
        test_db.query(WikiGeneration).filter(WikiGeneration.id == generation_id).count()
        == 0
    )
    assert (
        test_db.query(WikiContent)
        .filter(WikiContent.generation_id == generation_id)
        .count()
        == 0
    )


def test_forgetting_a_repository_leaves_other_wikis_of_it_alone(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """A repository may have several wikis. Deleting one must not take the others."""
    from app.services.knowledge.code_wiki.registry import forget_repository

    other = WikiProject(
        project_name=SOURCE["projectName"],
        project_type="git",
        source_type=SOURCE["sourceType"],
        source_url=SOURCE["sourceUrl"],
        source_domain=SOURCE["sourceDomain"],
        kind_id=knowledge_base.id + 1,
        is_active=True,
    )
    test_db.add(other)
    test_db.flush()

    forget_repository(test_db, knowledge_base.id)
    test_db.flush()

    assert test_db.get(WikiProject, other.id) is not None


# --- whether the run shows up as a conversation -----------------------------


def _set_spec(test_db: Session, knowledge_base: Kind, **values) -> None:
    payload = dict(knowledge_base.json or {})
    spec = dict(payload.get("spec", {}))
    spec.update(values)
    payload["spec"] = spec
    knowledge_base.json = payload
    test_db.flush()


def test_a_generation_run_stays_out_of_the_conversation_list_by_default(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """A wiki regenerates on its own, so its runs are work the user did not start a
    conversation to do. Listed, they bury the conversations they did start.
    """
    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    assert tasks.namespaces[0] == "system"


def test_a_wiki_may_ask_for_its_runs_to_be_listed(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    _set_spec(test_db, knowledge_base, showGenerationTask=True)

    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    assert tasks.namespaces[0] == "default"


def test_the_run_uses_the_model_the_wiki_was_created_with(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """Which model reads the repository is the creator's choice, so it has to reach
    the task. Nothing else carries it: the team's bot would otherwise decide.
    """
    _set_spec(
        test_db,
        knowledge_base,
        executionModelRef={"name": "claude-opus-5", "type": "public"},
    )

    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    created = tasks.created[0]
    assert created.model_id == "claude-opus-5"
    assert created.force_override_bot_model_type == "public"
    # Set by TaskCreate itself from model_id. Without it the executor reads the
    # choice as advisory and the bot's own model wins anyway.
    assert created.force_override_bot_model is True


def test_a_wiki_created_before_the_model_field_runs_on_its_team_s_model(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """The field is required for new wikis, so an absent one means an older wiki.
    Those keep running on whatever their team binds, as they always have -- sending
    an empty override instead would break them.
    """
    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    created = tasks.created[0]
    assert created.model_id is None
    assert created.force_override_bot_model is False


def test_a_model_ref_naming_nothing_is_not_sent_as_an_override(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """A ref with no name cannot select anything. Passed through, it would set the
    override flag on an empty id and strand the run with no model at all.
    """
    _set_spec(test_db, knowledge_base, executionModelRef={"type": "public"})

    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    assert tasks.created[0].model_id is None
    assert tasks.created[0].force_override_bot_model is False


def test_a_stored_name_of_spaces_is_not_sent_as_an_override(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """A name of spaces is truthy, so it used to reach the task, which reads any
    truthy name as a deliberate override -- pinning the run to a model that cannot
    resolve. The request schema rejects this now, but rows written before it did are
    still in the table, so the run re-checks what it reads.
    """
    _set_spec(test_db, knowledge_base, executionModelRef={"name": "   "})

    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    assert tasks.created[0].model_id is None
    assert tasks.created[0].force_override_bot_model is False


def test_a_stored_type_that_is_not_a_model_scope_falls_back_whole(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """An unsupported scope fails to resolve as surely as a missing name, so the
    whole reference is dropped rather than half of it applied: the team's model runs
    the wiki, which is a model that works.
    """
    _set_spec(
        test_db,
        knowledge_base,
        executionModelRef={"name": "claude-opus-5", "type": "not-a-scope"},
    )

    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    assert tasks.created[0].model_id is None
    assert tasks.created[0].force_override_bot_model is False


def test_a_stored_type_of_spaces_reaches_the_task_as_no_type_at_all(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """A blank type is unset, and has to arrive unset.

    It passes the scope check -- there is nothing to check -- so the danger is not
    rejection but survival: carried through as the original "   ", it reaches the
    task as a non-empty scope that matches nothing, which is the same broken
    override the check exists to prevent.
    """
    _set_spec(
        test_db,
        knowledge_base,
        executionModelRef={"name": "claude-opus-5", "type": "   "},
    )

    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    created = tasks.created[0]
    assert created.model_id == "claude-opus-5"
    assert created.force_override_bot_model_type is None


def test_a_stored_name_is_trimmed_before_it_reaches_the_task(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """Surrounding space would make the id miss a model that is really there."""
    _set_spec(
        test_db,
        knowledge_base,
        executionModelRef={"name": "  claude-opus-5  ", "type": "runtime"},
    )

    start_run(test_db, knowledge_base=knowledge_base, user=test_user, head_commit=HEAD)

    assert tasks.created[0].model_id == "claude-opus-5"
    # runtime is a real scope, so it must survive the check rather than be rejected
    # along with the genuinely unsupported values.
    assert tasks.created[0].force_override_bot_model_type == "runtime"


def test_the_hiding_namespace_is_the_one_the_listing_query_excludes():
    """The whole mechanism is that these two agree. The exclusion is written into raw
    SQL rather than expressed through the model, so nothing else ties the constant
    used here to the value that query filters on -- a rename on either side would
    silently start listing every wiki run again, with no test failing.
    """
    from app.services.knowledge.code_wiki.runner import HIDDEN_TASK_NAMESPACE
    from app.stores.tasks.sqlalchemy_task_store import (
        _ACCESSIBLE_IDS_SQL,
        _OWNED_IDS_SQL,
    )

    excluded = f"k.namespace != '{HIDDEN_TASK_NAMESPACE}'"
    assert excluded in str(_ACCESSIBLE_IDS_SQL)
    assert excluded in str(_OWNED_IDS_SQL)


def test_a_pinned_commit_lets_the_next_run_be_incremental(
    monkeypatch,
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects,
):
    """The loop this closes, end to end.

    A published version with no commit is not a cosmetic gap: published_commit
    returns nothing, so the next run has nothing to diff against and is full, and it
    publishes without a commit too. Two runs is the shortest sequence that shows it
    — the second one has to be incremental, and it can only be if the first recorded
    what it documented.
    """
    from app.services.knowledge.code_wiki import runner
    from app.services.knowledge.code_wiki.repo_state import RepositoryState
    from app.services.knowledge.code_wiki.run_mode import ChangedPath

    monkeypatch.setattr(
        runner,
        "read_repository_state",
        lambda *args, **kwargs: RepositoryState(head_commit="aaaaaaa"),
    )
    first = start_run(test_db, knowledge_base=knowledge_base, user=test_user)
    _write_page(test_db, first.generation, "index")
    finish_run(test_db, generation=first.generation, succeeded=True)

    # The repository has moved, and one file changed.
    monkeypatch.setattr(
        runner,
        "read_repository_state",
        lambda *args, **kwargs: RepositoryState(
            head_commit="bbbbbbb", changed_paths=[ChangedPath("src/one.py", "M")]
        ),
    )
    second = start_run(test_db, knowledge_base=knowledge_base, user=test_user)

    assert second.started
    assert second.mode == "incremental"


def test_a_run_executes_as_the_wiki_owner_not_whoever_triggered_it(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """A member the wiki is shared with may trigger a run. Doing so must not make
    them the identity that clones the repository and owns what it writes.

    It used to. The caller became the task's user, the generation's user, and the
    owner of every page projected out of the version — so a member with no
    credentials for that host failed at checkout on somebody else's wiki, and the
    pages a successful run wrote changed hands. The function's own docstring said
    the owner ran it; only the code disagreed.
    """
    member = User(
        user_name="shared-member",
        email="member@example.com",
        password_hash="x",
        is_active=True,
    )
    test_db.add(member)
    test_db.flush()

    started = start_run(
        test_db, knowledge_base=knowledge_base, user=member, head_commit=HEAD
    )

    assert started.started
    assert knowledge_base.user_id == test_user.id
    assert started.generation.user_id == test_user.id


# --- going back to an earlier version ----------------------------------------


def test_an_earlier_version_can_be_published_again(
    test_db: Session,
    knowledge_base: Kind,
    test_user: User,
    tasks: FakeTasks,
    no_side_effects,
    monkeypatch,
):
    """The gate is advisory, so a run that goes wrong reaches readers. Everything it
    replaced is retained, and until this there was no way back to any of it — the
    published pointer only ever moved forward.
    """
    from app.services.knowledge.code_wiki import runner
    from app.services.knowledge.code_wiki.publisher import published_generation_id
    from app.services.knowledge.code_wiki.repo_state import RepositoryState
    from app.services.knowledge.code_wiki.runner import republish_generation

    monkeypatch.setattr(
        runner,
        "read_repository_state",
        lambda *args, **kwargs: RepositoryState(head_commit="aaaaaaa"),
    )
    good = start_run(test_db, knowledge_base=knowledge_base, user=test_user).generation
    for path in ("index", "architecture", "modules"):
        _write_page(test_db, good, path)
    finish_run(test_db, generation=good, succeeded=True)

    monkeypatch.setattr(
        runner,
        "read_repository_state",
        lambda *args, **kwargs: RepositoryState(head_commit="bbbbbbb"),
    )
    thin = start_run(test_db, knowledge_base=knowledge_base, user=test_user).generation
    _write_page(test_db, thin, "index")
    finish_run(test_db, generation=thin, succeeded=True)
    assert published_generation_id(knowledge_base) == thin.id

    republish_generation(test_db, knowledge_base=knowledge_base, generation_id=good.id)

    assert published_generation_id(knowledge_base) == good.id


def test_a_version_from_another_wiki_is_refused(
    test_db: Session, knowledge_base: Kind, test_user: User
):
    """Otherwise one wiki's pages could be projected into another by id."""
    from app.services.knowledge.code_wiki.runner import republish_generation

    stranger = WikiGeneration(
        project_id=1,
        kind_id=knowledge_base.id + 999,
        user_id=test_user.id,
        task_id=0,
        team_id=0,
        source_snapshot={},
        status=WikiGenerationStatus.COMPLETED,
        completed_at=datetime(2026, 8, 1),
    )
    test_db.add(stranger)
    test_db.flush()

    with pytest.raises(CodeWikiRunError, match="does not belong"):
        republish_generation(
            test_db,
            knowledge_base=knowledge_base,
            generation_id=stranger.id,
        )


def test_a_version_that_never_finished_is_refused(
    test_db: Session, knowledge_base: Kind, test_user: User, tasks: FakeTasks
):
    """A running or failed version holds no result to publish -- for a failed one the
    pages may be there, but they are the pages of a run that did not succeed.
    """
    from app.services.knowledge.code_wiki.runner import republish_generation

    started = start_run(test_db, knowledge_base=knowledge_base, user=test_user)

    with pytest.raises(CodeWikiRunError, match="holds no result"):
        republish_generation(
            test_db,
            knowledge_base=knowledge_base,
            generation_id=started.generation.id,
        )
