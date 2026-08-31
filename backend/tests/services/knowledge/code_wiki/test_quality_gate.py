# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for explicit Code Wiki review handoffs and verdicts."""

from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models.wiki import WikiContent, WikiGeneration
from app.schemas.wiki import (
    WikiGenerationReviewOpenRequest,
    WikiGenerationReviewRequest,
)
from app.services.knowledge.code_wiki.projection_plan import PageSource
from app.services.knowledge.code_wiki.quality_gate import (
    open_quality_review,
    quality_gate_reason,
    record_quality_review,
    review_state,
)
from app.services.knowledge.code_wiki.version_store import set_page_path


def _generation(test_db, test_user) -> WikiGeneration:
    generation = WikiGeneration(
        project_id=1,
        kind_id=1,
        user_id=test_user.id,
        task_id=1,
        team_id=1,
        source_snapshot={},
        ext={
            "qualityReview": {
                "required": True,
                "handoffs": [],
                "checkpoints": [],
            }
        },
        completed_at=datetime(1970, 1, 1),
    )
    test_db.add(generation)
    test_db.flush()
    return generation


def _page(test_db, generation: WikiGeneration, path: str, content: str = "body"):
    page = WikiContent(
        generation_id=generation.id,
        type="chapter",
        title=path,
        content=content,
        parent_id=0,
    )
    set_page_path(page, path)
    test_db.add(page)
    test_db.commit()
    return page


def _open(
    test_db,
    generation: WikiGeneration,
    phase: str,
    *,
    paths: list[str] | None = None,
    handoff: str | None = None,
):
    return open_quality_review(
        test_db,
        generation=generation,
        payload=WikiGenerationReviewOpenRequest(
            generation_id=generation.id,
            phase=phase,
            paths=paths or ["index"],
            summary=f"{phase} handoff",
            handoff=handoff
            or f"# {phase.title()} handoff\n\nReview the supplied scope.",
        ),
    )


def _review(
    test_db,
    generation: WikiGeneration,
    phase: str,
    status: str,
    *,
    paths: list[str] | None = None,
    focus_paths: list[str] | None = None,
):
    review_paths = paths or ["index"]
    if review_state(generation, phase=phase)["state"] != "ready":
        _open(test_db, generation, phase, paths=review_paths)
    return record_quality_review(
        test_db,
        generation=generation,
        payload=WikiGenerationReviewRequest(
            generation_id=generation.id,
            phase=phase,
            status=status,
            paths=review_paths,
            focus_paths=(focus_paths or ["index"]) if phase == "plan" else [],
            summary=f"{phase} {status}",
            findings=(
                "## Finding\n- Path: index\n- Required change: add detail"
                if status == "changes_requested"
                else None
            ),
        ),
    )


def _pages(content: str = "body") -> list[PageSource]:
    return [PageSource(path="index", title="index", content=content)]


def test_writer_handoff_makes_the_phase_ready(test_db, test_user):
    generation = _generation(test_db, test_user)

    state = _open(test_db, generation, "plan", handoff="# Plan\n\n- index")

    assert state["generationId"] == generation.id
    assert state["state"] == "ready"
    assert state["attempt"] == 1
    assert state["nextAction"] == "review_handoff_and_submit_verdict"
    assert state["handoff"]["handoff"] == "# Plan\n\n- index"


def test_reviewer_cannot_submit_without_a_writer_handoff(test_db, test_user):
    generation = _generation(test_db, test_user)

    with pytest.raises(HTTPException, match="run review-open"):
        record_quality_review(
            test_db,
            generation=generation,
            payload=WikiGenerationReviewRequest(
                generation_id=generation.id,
                phase="plan",
                status="passed",
                paths=["index"],
                focus_paths=["index"],
                summary="plan passed",
            ),
        )


def test_reviewer_verdict_is_immediately_durable(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")

    state = _review(test_db, generation, "plan", "passed")

    assert state["state"] == "passed"
    assert state["nextAction"] == "write_pages_then_open_qa"
    assert state["review"]["attempt"] == 1
    assert state["review"]["focusPaths"] == ["index"]
    assert set(generation.ext["qualityReview"]) == {
        "required",
        "handoffs",
        "checkpoints",
    }


def test_repeating_the_same_verdict_is_idempotent(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "passed")

    state = record_quality_review(
        test_db,
        generation=generation,
        payload=WikiGenerationReviewRequest(
            generation_id=generation.id,
            phase="plan",
            status="passed",
            paths=["index"],
            focus_paths=["index"],
            summary="plan passed",
        ),
    )

    assert state["state"] == "passed"
    assert len(generation.ext["qualityReview"]["checkpoints"]) == 1


def test_full_rebuild_requires_a_passed_plan_and_qa(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")

    assert "passed plan review" in quality_gate_reason(generation, _pages())
    _review(test_db, generation, "plan", "passed")
    assert "final QA" in quality_gate_reason(generation, _pages())
    _review(test_db, generation, "qa", "passed")
    assert quality_gate_reason(generation, _pages()) == ""


def test_qa_changes_require_one_passing_recheck(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "passed")
    state = _review(test_db, generation, "qa", "changes_requested")

    assert state["nextAction"] == "repair_pages_then_open_recheck"
    assert "recheck did not pass" in quality_gate_reason(generation, _pages())
    state = _review(test_db, generation, "recheck", "passed")
    assert state["nextAction"] == "complete_generation"
    assert quality_gate_reason(generation, _pages()) == ""


def test_plan_changes_allow_one_re_review(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    first = _review(test_db, generation, "plan", "changes_requested")

    assert first["nextAction"] == "revise_plan_then_open_plan"
    second = _review(test_db, generation, "plan", "passed")

    assert second["state"] == "passed"
    assert second["attempt"] == 2


def test_second_plan_changes_verdict_is_recorded_and_requires_failure(
    test_db, test_user
):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "changes_requested")

    second = _review(test_db, generation, "plan", "changes_requested")

    assert second["state"] == "changes_requested"
    assert second["attempt"] == 2
    assert second["nextAction"] == "fail_generation"
    with pytest.raises(HTTPException, match="already closed"):
        _open(test_db, generation, "plan")


def test_qa_requires_a_passed_plan(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")

    with pytest.raises(HTTPException, match="only after the plan review passes"):
        _open(test_db, generation, "qa")


def test_a_recheck_requires_qa_to_request_changes(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "passed")

    with pytest.raises(HTTPException, match="only after QA requests changes"):
        _open(test_db, generation, "recheck")


def test_pages_cannot_change_during_an_open_review(test_db, test_user):
    generation = _generation(test_db, test_user)
    page = _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "passed")
    _open(test_db, generation, "qa")
    page.content = "changed while QA was running"
    test_db.commit()

    with pytest.raises(HTTPException, match="changed after the review handoff"):
        record_quality_review(
            test_db,
            generation=generation,
            payload=WikiGenerationReviewRequest(
                generation_id=generation.id,
                phase="qa",
                status="passed",
                paths=["index"],
                summary="qa passed",
            ),
        )


def test_qa_handoff_must_name_every_written_page(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _page(test_db, generation, "architecture")
    _review(
        test_db,
        generation,
        "plan",
        "passed",
        paths=["index", "architecture"],
        focus_paths=["architecture"],
    )

    with pytest.raises(HTTPException, match="must match every page"):
        _open(test_db, generation, "qa", paths=["index"])


def test_a_page_change_invalidates_the_latest_passing_review(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "passed")
    _review(test_db, generation, "qa", "passed")

    assert "changed after" in quality_gate_reason(generation, _pages("changed"))


def test_changes_requested_requires_actionable_findings(test_db, test_user):
    generation = _generation(test_db, test_user)
    _open(test_db, generation, "plan")

    with pytest.raises(HTTPException, match="requires actionable findings"):
        record_quality_review(
            test_db,
            generation=generation,
            payload=WikiGenerationReviewRequest(
                generation_id=generation.id,
                phase="plan",
                status="changes_requested",
                paths=["index"],
                summary="plan needs changes",
            ),
        )


def test_passed_review_rejects_unresolved_findings(test_db, test_user):
    generation = _generation(test_db, test_user)
    _open(test_db, generation, "plan")

    with pytest.raises(HTTPException, match="must not include unresolved findings"):
        record_quality_review(
            test_db,
            generation=generation,
            payload=WikiGenerationReviewRequest(
                generation_id=generation.id,
                phase="plan",
                status="passed",
                paths=["index"],
                focus_paths=["index"],
                summary="plan passed",
                findings="one unresolved issue",
            ),
        )


def test_plan_review_requires_core_focus_paths_when_it_passes(test_db, test_user):
    generation = _generation(test_db, test_user)
    _open(test_db, generation, "plan")

    with pytest.raises(HTTPException, match="At least one reviewed path"):
        record_quality_review(
            test_db,
            generation=generation,
            payload=WikiGenerationReviewRequest(
                generation_id=generation.id,
                phase="plan",
                status="passed",
                paths=["index"],
                summary="plan passed without a focus page",
            ),
        )


def test_final_qa_must_cover_every_core_focus_page(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _page(test_db, generation, "architecture")
    _review(
        test_db,
        generation,
        "plan",
        "passed",
        paths=["index", "architecture"],
        focus_paths=["index", "architecture"],
    )
    _open(test_db, generation, "qa", paths=["index", "architecture"])
    _review(test_db, generation, "qa", "passed")

    assert "every core focus page" in quality_gate_reason(
        generation,
        [
            PageSource(path="index", title="index", content="body"),
            PageSource(path="architecture", title="architecture", content="body"),
        ],
    )


def test_state_is_not_started_until_the_writer_opens_a_handoff(test_db, test_user):
    generation = _generation(test_db, test_user)

    assert review_state(generation, phase="plan") == {
        "generationId": generation.id,
        "phase": "plan",
        "state": "not_started",
        "attempt": None,
        "nextAction": "open_plan_review",
    }
