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
    PLAN_ONLY_REVIEW_POLICY,
    open_quality_review,
    quality_gate_reason,
    record_quality_review,
    review_state,
    writing_progress,
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
    writing_plan: dict | None = None,
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
            writing_plan=writing_plan,
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
            focus_paths=(
                (focus_paths if focus_paths is not None else ["index"])
                if phase in {"plan", "plan_amendment"}
                else []
            ),
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
    assert state["handoff"]["handoff"].startswith("# Plan")
    assert state["handoff"]["writingPlan"] == {
        "mode": "coordinator",
        "coordinatorPaths": ["index"],
        "workPackages": [],
    }
    assert set(generation.ext["qualityReview"]) == {
        "required",
        "handoffs",
        "checkpoints",
    }


def test_plan_only_completes_after_the_exact_planned_page_set(test_db, test_user):
    generation = _generation(test_db, test_user)
    generation.ext = {
        "qualityReview": {
            **generation.ext["qualityReview"],
            "policy": PLAN_ONLY_REVIEW_POLICY,
        }
    }
    _page(test_db, generation, "index")

    state = _review(test_db, generation, "plan", "passed")

    assert state["reviewPolicy"] == "plan_only"
    assert state["nextAction"] == "write_pages_then_complete"
    assert review_state(generation, phase="qa")["nextAction"] == "not_required"
    assert quality_gate_reason(generation, _pages()) == ""


def test_passed_plan_amendment_becomes_the_effective_page_set(test_db, test_user):
    generation = _generation(test_db, test_user)
    generation.ext["qualityReview"]["policy"] = PLAN_ONLY_REVIEW_POLICY
    _page(test_db, generation, "index")
    _review(
        test_db,
        generation,
        "plan",
        "passed",
        paths=["index", "architecture"],
        focus_paths=["architecture"],
    )

    state = _open(
        test_db,
        generation,
        "plan_amendment",
        paths=["index", "architecture", "architecture/runtime"],
        handoff="# Plan amendment\n\nAdd the runtime lifecycle page.",
    )

    assert state["state"] == "ready"
    assert state["effectivePlan"]["paths"] == ["architecture", "index"]
    state = _review(
        test_db,
        generation,
        "plan_amendment",
        "passed",
        paths=["index", "architecture", "architecture/runtime"],
        focus_paths=["architecture/runtime"],
    )
    _page(test_db, generation, "architecture")
    _page(test_db, generation, "architecture/runtime")

    assert state["nextAction"] == "write_pages_then_complete"
    assert state["effectivePlan"] == {
        "phase": "plan_amendment",
        "paths": ["architecture", "architecture/runtime", "index"],
        "focusPaths": ["architecture", "architecture/runtime"],
        "writingPlan": {
            "mode": "coordinator",
            "coordinatorPaths": ["architecture", "architecture/runtime", "index"],
            "workPackages": [],
        },
    }
    assert writing_progress(test_db, generation)["missingPaths"] == []
    assert (
        quality_gate_reason(
            generation,
            [
                PageSource(path="index", title="index", content="body"),
                PageSource(path="architecture", title="architecture", content="body"),
                PageSource(
                    path="architecture/runtime", title="runtime", content="body"
                ),
            ],
        )
        == ""
    )
    with pytest.raises(HTTPException, match="amendment is already closed"):
        _open(
            test_db,
            generation,
            "plan_amendment",
            paths=[
                "index",
                "architecture",
                "architecture/runtime",
                "operations",
            ],
        )


def test_plan_amendment_must_add_paths_and_settle_before_publication(
    test_db, test_user
):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "passed")

    with pytest.raises(HTTPException, match="must add paths"):
        _open(test_db, generation, "plan_amendment", paths=["index"])

    _open(test_db, generation, "plan_amendment", paths=["index", "operations"])
    assert "unresolved plan amendment" in quality_gate_reason(generation, _pages())


def test_plan_amendment_cannot_retroactively_approve_a_written_page(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "passed")
    _page(test_db, generation, "operations")

    with pytest.raises(HTTPException, match="before writing its added pages"):
        _open(test_db, generation, "plan_amendment", paths=["index", "operations"])


def test_plan_amendment_can_keep_the_original_focus_paths(test_db, test_user):
    generation = _generation(test_db, test_user)
    _review(test_db, generation, "plan", "passed", focus_paths=["index"])
    _open(test_db, generation, "plan_amendment", paths=["index", "operations"])

    state = _review(
        test_db,
        generation,
        "plan_amendment",
        "passed",
        paths=["index", "operations"],
        focus_paths=[],
    )

    assert state["effectivePlan"]["focusPaths"] == ["index"]


def test_plan_amendment_is_rejected_before_plan_or_after_qa_starts(test_db, test_user):
    generation = _generation(test_db, test_user)

    assert (
        review_state(generation, phase="plan_amendment")["nextAction"]
        == "complete_plan_review_first"
    )

    with pytest.raises(HTTPException, match="only after the plan review passes"):
        _open(test_db, generation, "plan_amendment", paths=["index", "operations"])

    _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "passed")
    assert (
        review_state(generation, phase="plan_amendment")["nextAction"]
        == "continue_writing"
    )
    _open(test_db, generation, "qa")

    with pytest.raises(HTTPException, match="not allowed after QA has started"):
        _open(test_db, generation, "plan_amendment", paths=["index", "operations"])


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


def test_qa_requires_an_open_plan_amendment_to_pass(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _review(test_db, generation, "plan", "passed")

    _open(test_db, generation, "plan_amendment", paths=["index", "operations"])
    with pytest.raises(HTTPException, match="only after the Plan amendment passes"):
        _open(test_db, generation, "qa")

    _review(
        test_db,
        generation,
        "plan_amendment",
        "changes_requested",
        paths=["index", "operations"],
    )
    with pytest.raises(HTTPException, match="only after the Plan amendment passes"):
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


def test_scoped_writing_plan_assigns_every_page_once(test_db, test_user):
    generation = _generation(test_db, test_user)

    state = _open(
        test_db,
        generation,
        "plan",
        paths=["index", "architecture", "architecture/runtime"],
        writing_plan={
            "mode": "scoped",
            "language": "Chinese (Simplified)",
            "coordinator_paths": ["index", "architecture"],
            "work_packages": [{"id": "WP-01", "paths": ["architecture/runtime"]}],
        },
    )

    assert state["handoff"]["writingPlan"] == {
        "mode": "scoped",
        "language": "Chinese (Simplified)",
        "coordinatorPaths": ["architecture", "index"],
        "workPackages": [{"id": "WP-01", "paths": ["architecture/runtime"]}],
    }


@pytest.mark.parametrize(
    "writing_plan, message",
    [
        (
            {
                "mode": "scoped",
                "language": "Chinese (Simplified)",
                "coordinator_paths": ["index"],
                "work_packages": [{"id": "WP-01", "paths": ["index"]}],
            },
            "assigns pages more than once",
        ),
        (
            {
                "mode": "scoped",
                "language": "Chinese (Simplified)",
                "coordinator_paths": ["index"],
                "work_packages": [],
            },
            "ownership must exactly match",
        ),
        (
            {
                "mode": "scoped",
                "language": " ",
                "coordinator_paths": ["index"],
                "work_packages": [{"id": "WP-01", "paths": ["architecture"]}],
            },
            "requires an output language",
        ),
    ],
)
def test_writing_plan_rejects_ambiguous_ownership(
    test_db, test_user, writing_plan, message
):
    generation = _generation(test_db, test_user)

    with pytest.raises(HTTPException, match=message):
        _open(
            test_db,
            generation,
            "plan",
            paths=["index", "architecture"],
            writing_plan=writing_plan,
        )


def test_qa_requires_written_pages_to_exactly_match_the_passed_plan(test_db, test_user):
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "index")
    _review(
        test_db,
        generation,
        "plan",
        "passed",
        paths=["index", "architecture"],
        focus_paths=["architecture"],
    )

    with pytest.raises(HTTPException, match=r"missing=.*architecture"):
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

    with pytest.raises(HTTPException, match="core focus path"):
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


def test_review_path_comparisons_follow_storage_collation(test_db, test_user) -> None:
    generation = _generation(test_db, test_user)
    _page(test_db, generation, "architecture")
    _review(
        test_db,
        generation,
        "plan",
        "passed",
        paths=["Architecture"],
        focus_paths=["ARCHITECTURE"],
    )
    _open(test_db, generation, "qa", paths=["ARCHITECTURE"])
    state = _review(
        test_db,
        generation,
        "qa",
        "passed",
        paths=["architecture"],
    )

    progress = writing_progress(test_db, generation)
    assert progress is not None
    assert progress["missingPaths"] == []
    assert progress["unexpectedPaths"] == []
    assert state["state"] == "passed"
    assert (
        quality_gate_reason(
            generation,
            [PageSource(path="architecture", title="architecture", content="body")],
        )
        == ""
    )


def test_qa_verdict_must_cover_every_candidate_page(test_db, test_user):
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
    with pytest.raises(HTTPException, match="every page"):
        _review(test_db, generation, "qa", "passed")


def test_state_is_not_started_until_the_writer_opens_a_handoff(test_db, test_user):
    generation = _generation(test_db, test_user)

    assert review_state(generation, phase="plan") == {
        "generationId": generation.id,
        "phase": "plan",
        "state": "not_started",
        "attempt": None,
        "reviewPolicy": "plan_and_qa",
        "nextAction": "open_plan_review",
    }
