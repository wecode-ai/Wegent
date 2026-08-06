# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for writing pages into a version by path.

Matching on path rather than title is what keeps a page's document id — and with it
its RAG index entry and any stored citation — stable when the agent rewords a heading.
"""

from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.wiki import (
    WikiContent,
    WikiGeneration,
    WikiGenerationStatus,
    WikiGenerationType,
)
from app.schemas.wiki import WikiContentSection, WikiContentWriteRequest
from app.services.knowledge.code_wiki.version_store import page_path_of
from app.services.wiki_service import WikiService

KIND_ID = 91


@pytest.fixture
def generation(test_db: Session) -> WikiGeneration:
    record = WikiGeneration(
        project_id=1,
        kind_id=KIND_ID,
        user_id=1,
        task_id=0,
        team_id=1,
        generation_type=WikiGenerationType.INCREMENTAL,
        source_snapshot={},
        status=WikiGenerationStatus.RUNNING,
        # The column defaults to a string literal, which SQLite refuses.
        completed_at=datetime(1970, 1, 1),
    )
    test_db.add(record)
    test_db.flush()
    return record


def _write(db: Session, generation: WikiGeneration, *sections: WikiContentSection):
    WikiService().save_generation_contents(
        db,
        WikiContentWriteRequest(generation_id=generation.id, sections=list(sections)),
    )


def _section(path: str | None, title: str, content: str = "body") -> WikiContentSection:
    return WikiContentSection(type="chapter", title=title, content=content, path=path)


def _knowledge_base(db: Session):
    """The run only concludes as a code wiki's when its kind_id names a real one."""
    from app.models.kind import Kind

    kind = Kind(
        id=KIND_ID,
        kind="KnowledgeBase",
        name="kb-content-write",
        namespace="default",
        user_id=1,
        json={"spec": {"name": "wiki", "kbType": "code_wiki"}},
        is_active=True,
    )
    db.add(kind)
    db.flush()
    return kind


def _pages(db: Session, generation_id: int) -> list[WikiContent]:
    return (
        db.query(WikiContent).filter(WikiContent.generation_id == generation_id).all()
    )


def test_a_page_is_written_with_its_path(test_db: Session, generation: WikiGeneration):
    _write(test_db, generation, _section("architecture/backend", "Backend"))

    (page,) = _pages(test_db, generation.id)
    assert page_path_of(page) == "architecture/backend"
    assert page.title == "Backend"


def test_rewording_a_title_revises_the_same_page(
    test_db: Session, generation: WikiGeneration
):
    """The point of path identity: no delete-and-recreate, so the id survives."""
    _write(test_db, generation, _section("architecture/backend", "Backend", "v1"))
    (original,) = _pages(test_db, generation.id)

    _write(
        test_db,
        generation,
        _section("architecture/backend", "The Backend Service", "v2"),
    )

    pages = _pages(test_db, generation.id)
    assert len(pages) == 1
    assert pages[0].id == original.id
    assert pages[0].title == "The Backend Service"
    assert pages[0].content == "v2"


def test_moving_a_page_to_a_new_path_creates_a_new_page(
    test_db: Session, generation: WikiGeneration
):
    _write(test_db, generation, _section("architecture/backend", "Backend"))

    _write(test_db, generation, _section("services/backend", "Backend"))

    assert {page_path_of(page) for page in _pages(test_db, generation.id)} == {
        "architecture/backend",
        "services/backend",
    }


def test_the_path_survives_a_rewrite_that_supplies_no_ext(
    test_db: Session, generation: WikiGeneration
):
    """``ext`` is replaced wholesale on update, which previously dropped the path."""
    _write(test_db, generation, _section("architecture/backend", "Backend", "v1"))

    _write(test_db, generation, _section("architecture/backend", "Backend", "v2"))

    (page,) = _pages(test_db, generation.id)
    assert page_path_of(page) == "architecture/backend"


def test_a_path_is_normalized_before_it_is_stored(
    test_db: Session, generation: WikiGeneration
):
    _write(test_db, generation, _section(" architecture//backend.md ", "Backend"))

    (page,) = _pages(test_db, generation.id)
    assert page_path_of(page) == "architecture/backend"


def test_a_malformed_path_fails_the_write_not_the_publish(
    test_db: Session, generation: WikiGeneration
):
    with pytest.raises(HTTPException) as exc:
        _write(test_db, generation, _section("../escape", "Escape"))

    assert exc.value.status_code == 400


def test_two_paths_colliding_by_case_are_refused(
    test_db: Session, generation: WikiGeneration
):
    """The knowledge tables collate case-insensitively; both cannot be honoured."""
    with pytest.raises(HTTPException) as exc:
        _write(
            test_db,
            generation,
            _section("architecture/backend", "One"),
            _section("Architecture/Backend", "Two"),
        )

    assert exc.value.status_code == 400
    assert "case" in exc.value.detail


def test_a_rejected_write_leaves_the_version_unchanged(
    test_db: Session, generation: WikiGeneration
):
    _write(test_db, generation, _section("index", "Index"))

    with pytest.raises(HTTPException):
        _write(test_db, generation, _section("bad\\path", "Bad"))

    assert {page_path_of(page) for page in _pages(test_db, generation.id)} == {"index"}


def test_writes_without_a_path_still_match_on_title(
    test_db: Session, generation: WikiGeneration
):
    """The legacy write path predates page identity and must keep working."""
    _write(test_db, generation, _section(None, "Overview", "v1"))

    _write(test_db, generation, _section(None, "Overview", "v2"))

    (page,) = _pages(test_db, generation.id)
    assert page.content == "v2"


def test_a_legacy_write_never_resolves_to_a_path_identified_page(
    test_db: Session, generation: WikiGeneration
):
    """Moving a page keeps its title, so a title can name several pages.

    If the title fallback could reach them, which one a path-less write overwrote
    would depend on query order rather than on any rule.
    """
    _write(test_db, generation, _section("architecture/backend", "Backend", "kept"))
    _write(test_db, generation, _section("services/backend", "Backend", "kept too"))

    _write(test_db, generation, _section(None, "Backend", "legacy"))

    by_path = {
        page_path_of(page): page.content for page in _pages(test_db, generation.id)
    }
    assert by_path["architecture/backend"] == "kept"
    assert by_path["services/backend"] == "kept too"
    # The legacy write created its own path-less entry instead of hijacking one.
    assert by_path[""] == "legacy"


# --- removals ---------------------------------------------------------------


def _remove(db: Session, generation: WikiGeneration, *paths: str):
    WikiService().save_generation_contents(
        db,
        WikiContentWriteRequest(
            generation_id=generation.id, sections=[], removed_paths=list(paths)
        ),
    )


def test_a_page_the_agent_declares_gone_is_dropped_from_the_version(
    test_db: Session, generation: WikiGeneration
):
    """An incremental version is a copy of the published one, so not writing a page
    cannot mean removing it. Declaring it is the only channel there is."""
    _write(test_db, generation, _section("index", "Index"), _section("legacy", "Old"))

    _remove(test_db, generation, "legacy")

    assert {page_path_of(page) for page in _pages(test_db, generation.id)} == {"index"}


def test_a_removal_is_matched_the_same_way_a_write_is(
    test_db: Session, generation: WikiGeneration
):
    """A path spelled differently must still name the same page, or a removal
    silently does nothing and the page outlives its subject."""
    _write(test_db, generation, _section("modules/sync", "Sync"))

    _remove(test_db, generation, " Modules//Sync.md ")

    assert _pages(test_db, generation.id) == []


def test_removing_a_page_that_is_already_gone_is_not_an_error(
    test_db: Session, generation: WikiGeneration
):
    """A retried submission would otherwise lose the sections sent alongside it."""
    _write(test_db, generation, _section("index", "Index"))

    WikiService().save_generation_contents(
        test_db,
        WikiContentWriteRequest(
            generation_id=generation.id,
            sections=[_section("guide", "Guide")],
            removed_paths=["never-existed"],
        ),
    )

    assert {page_path_of(page) for page in _pages(test_db, generation.id)} == {
        "index",
        "guide",
    }


def test_a_malformed_removal_path_is_refused(
    test_db: Session, generation: WikiGeneration
):
    with pytest.raises(HTTPException) as exc:
        _remove(test_db, generation, "../escape")

    assert exc.value.status_code == 400


def test_a_page_written_and_removed_in_one_payload_ends_up_removed(
    test_db: Session, generation: WikiGeneration
):
    """Order within a payload must not decide the outcome."""
    WikiService().save_generation_contents(
        test_db,
        WikiContentWriteRequest(
            generation_id=generation.id,
            sections=[_section("doomed", "Doomed")],
            removed_paths=["doomed"],
        ),
    )

    assert _pages(test_db, generation.id) == []


def test_a_payload_with_nothing_in_it_is_still_refused(
    test_db: Session, generation: WikiGeneration
):
    with pytest.raises(HTTPException) as exc:
        WikiService().save_generation_contents(
            test_db,
            WikiContentWriteRequest(generation_id=generation.id, sections=[]),
        )

    assert exc.value.status_code == 400


# --- reading a page back ----------------------------------------------------


def test_a_written_page_can_be_read_back(test_db: Session, generation: WikiGeneration):
    """Without this the instruction to revise a page cannot be followed: the agent
    knows the path and cannot see a word of what the page says."""
    _write(test_db, generation, _section("architecture/backend", "Backend", "v1"))

    page = WikiService().get_generation_page(
        test_db, generation.id, "architecture/backend"
    )

    assert page is not None
    assert page.path == "architecture/backend"
    assert page.title == "Backend"
    assert page.content == "v1"


def test_a_page_is_read_by_the_same_path_that_would_write_it(
    test_db: Session, generation: WikiGeneration
):
    """Resolving reads and writes differently would let the agent read one page and
    overwrite another."""
    _write(test_db, generation, _section("modules/sync", "Sync", "body"))

    page = WikiService().get_generation_page(
        test_db, generation.id, " Modules//Sync.md "
    )

    assert page is not None and page.content == "body"


def test_a_path_holding_no_page_reads_as_absent(
    test_db: Session, generation: WikiGeneration
):
    """An answer, not a failure: in an incremental run it means the page is new."""
    assert WikiService().get_generation_page(test_db, generation.id, "nothing") is None


def test_a_malformed_path_is_refused_rather_than_read_as_absent(
    test_db: Session, generation: WikiGeneration
):
    with pytest.raises(HTTPException) as exc:
        WikiService().get_generation_page(test_db, generation.id, "../escape")

    assert exc.value.status_code == 400


def test_a_pathless_legacy_entry_is_not_readable(
    test_db: Session, generation: WikiGeneration
):
    """It has no identity to ask for, and guessing would hand back a page the caller
    did not name."""
    _write(test_db, generation, _section(None, "Overview", "legacy"))

    assert WikiService().get_generation_page(test_db, generation.id, "overview") is None


def test_a_skill_identity_token_is_accepted(test_db, test_user):
    """What a skill running inside an executor actually holds.

    The task token it is also given carries no `sub` claim, so the ordinary user
    lookup rejects it — which surfaced as "Invalid authorization token" with the
    write API reachable only by the fixed operator token no executor is issued.
    """
    from app.api.endpoints.wiki import _verify_internal_token
    from app.services.auth import create_skill_identity_token

    token = create_skill_identity_token(
        user_id=test_user.id,
        user_name=test_user.user_name,
        runtime_type="executor",
        runtime_name="task-1-subtask-1",
    )

    # Raises when refused; returning is the assertion.
    _verify_internal_token(authorization=f"Bearer {token}", db=test_db)


def test_a_skill_identity_token_for_a_missing_user_is_refused(test_db):
    """The token proves what it says, not that the account still exists."""
    import pytest
    from fastapi import HTTPException

    from app.api.endpoints.wiki import _verify_internal_token
    from app.services.auth import create_skill_identity_token

    token = create_skill_identity_token(
        user_id=987654,
        user_name="ghost",
        runtime_type="executor",
        runtime_name="task-1-subtask-1",
    )

    with pytest.raises(HTTPException):
        _verify_internal_token(authorization=f"Bearer {token}", db=test_db)


def test_writing_a_page_does_not_read_back_the_others(
    test_db: Session, generation: WikiGeneration
):
    """The agent submits one page at a time, and each submission looked up the pages
    already written so a retitled one could still be found by path. It loaded their
    bodies too — so the Nth submission read back the full text of the first N-1, and
    a run's reads grew with the square of the pages it wrote. The pages are the
    largest thing in the table.

    Asserted by watching the SQL rather than the result, because the result is
    identical either way; that is what let it stand.
    """
    from sqlalchemy import event

    _write(test_db, generation, _section("a", "A", "aaaa" * 50))
    _write(test_db, generation, _section("b", "B", "bbbb" * 50))

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    engine = test_db.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        _write(test_db, generation, _section("c", "C", "cccc" * 50))
    finally:
        event.remove(engine, "before_cursor_execute", record)

    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    lookups = [s for s in selects if "wiki_contents" in s]
    assert lookups, "the page lookup should still happen"
    # Every column but the body: matching needs the path in ext and the title.
    assert not any("wiki_contents.content" in s for s in lookups), lookups


def test_concluding_a_run_reports_whether_it_was_published(
    test_db: Session, generation: WikiGeneration
):
    """The write API answered 204 and said nothing, so an agent whose version the
    gate refused was told its run had completed while its work was discarded — and it
    is the only party that can still act, because it is running and its checkout is
    there.
    """
    from unittest.mock import patch

    from app.schemas.wiki import WikiContentSummary

    _knowledge_base(test_db)
    _write(test_db, generation, _section("index", "Index"))

    with patch("app.services.wiki_service.finish_run") as finish:
        finish.return_value = SimpleNamespace(
            published=False,
            reason="rebuild came back with 1 pages where 20 were published",
        )
        refusal = WikiService().save_generation_contents(
            test_db,
            WikiContentWriteRequest(
                generation_id=generation.id,
                sections=[],
                summary=WikiContentSummary(status="COMPLETED"),
            ),
        )

    assert refusal == "rebuild came back with 1 pages where 20 were published"


def test_a_published_run_reports_no_refusal(
    test_db: Session, generation: WikiGeneration
):
    from unittest.mock import patch

    from app.schemas.wiki import WikiContentSummary

    _knowledge_base(test_db)
    _write(test_db, generation, _section("index", "Index"))

    with patch("app.services.wiki_service.finish_run") as finish:
        finish.return_value = SimpleNamespace(published=True, reason="")
        refusal = WikiService().save_generation_contents(
            test_db,
            WikiContentWriteRequest(
                generation_id=generation.id,
                sections=[],
                summary=WikiContentSummary(status="COMPLETED"),
            ),
        )

    assert refusal is None
