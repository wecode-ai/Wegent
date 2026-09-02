# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Review checkpoints required before a coordinated full rebuild is published."""

from __future__ import annotations

import hashlib
from typing import Iterable, Sequence

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.wiki import WikiContent, WikiGeneration
from app.schemas.wiki import (
    WikiGenerationReviewOpenRequest,
    WikiGenerationReviewRequest,
    WikiWritingPlan,
)
from app.services.knowledge.code_wiki.page_path import (
    InvalidPagePath,
    assert_unique_within_version,
    collation_key,
    normalize_page_path,
)
from app.services.knowledge.code_wiki.projection_plan import PageSource
from app.services.knowledge.code_wiki.version_store import page_path_of

QUALITY_REVIEW_EXT_KEY = "qualityReview"
PLAN_ONLY_REVIEW_POLICY = "plan_only"
PLAN_AND_QA_REVIEW_POLICY = "plan_and_qa"
PLAN_AMENDMENT_PHASE = "plan_amendment"


def require_quality_review(
    generation: WikiGeneration,
    *,
    policy: str = PLAN_ONLY_REVIEW_POLICY,
) -> None:
    """Mark a newly started full rebuild as requiring review checkpoints."""
    if policy not in {PLAN_ONLY_REVIEW_POLICY, PLAN_AND_QA_REVIEW_POLICY}:
        raise ValueError(f"Unknown Code Wiki review policy: {policy}")
    ext = dict(generation.ext or {})
    ext[QUALITY_REVIEW_EXT_KEY] = {
        "required": True,
        "policy": policy,
        "handoffs": [],
        "checkpoints": [],
    }
    generation.ext = ext


def open_quality_review(
    db: Session,
    *,
    generation: WikiGeneration,
    payload: WikiGenerationReviewOpenRequest,
) -> dict:
    """Persist the Writer handoff that makes one review attempt ready."""
    review = _required_review(generation)
    checkpoints = list(review.get("checkpoints") or [])
    handoffs = list(review.get("handoffs") or [])
    _assert_open_allowed(checkpoints, handoffs, payload.phase)

    paths = _normalized_paths(payload.paths)
    _assert_handoff_scope(db, generation, payload.phase, paths)
    writing_plan = _normalized_writing_plan(payload, paths)
    if payload.phase == PLAN_AMENDMENT_PHASE:
        _assert_additive_amendment_scope(db, generation, paths)
    attempt = 1 + sum(item.get("phase") == payload.phase for item in checkpoints)
    handoff = {
        "phase": payload.phase,
        "attempt": attempt,
        "paths": paths,
        "summary": payload.summary.strip(),
        "handoff": payload.handoff.strip(),
        "fingerprint": generation_fingerprint(db, generation.id),
    }
    if writing_plan is not None:
        handoff["writingPlan"] = writing_plan
    ready = _ready_handoff(handoffs, checkpoints, payload.phase)
    if ready is not None:
        if _handoff_matches(ready, handoff):
            return review_state(generation, phase=payload.phase)
        raise HTTPException(
            status_code=409,
            detail=f"The '{payload.phase}' review handoff is already ready",
        )

    handoffs.append(handoff)
    review["handoffs"] = handoffs
    _save_review(db, generation, review)
    return review_state(generation, phase=payload.phase)


def record_quality_review(
    db: Session,
    *,
    generation: WikiGeneration,
    payload: WikiGenerationReviewRequest,
) -> dict:
    """Persist one Reviewer verdict as the authoritative phase checkpoint."""
    review = _required_review(generation)
    _assert_findings(payload)

    paths = _normalized_paths(payload.paths)
    checkpoints = list(review.get("checkpoints") or [])
    handoffs = list(review.get("handoffs") or [])
    accepted = _latest(checkpoints, payload.phase)
    latest_handoff = _latest(handoffs, payload.phase)
    if (
        accepted is not None
        and latest_handoff is not None
        and accepted.get("attempt") == latest_handoff.get("attempt")
    ):
        repeated = {
            "phase": payload.phase,
            "attempt": latest_handoff["attempt"],
            "status": payload.status,
            "paths": paths,
            "focusPaths": _plan_focus_paths(payload, paths),
            "summary": payload.summary.strip(),
            "findings": (payload.findings or "").strip(),
            "fingerprint": accepted.get("fingerprint"),
        }
        if _review_matches(accepted, repeated):
            return review_state(generation, phase=payload.phase)
        raise HTTPException(
            status_code=409,
            detail=f"The '{payload.phase}' review attempt already has a verdict",
        )

    handoff = _ready_handoff(handoffs, checkpoints, payload.phase)
    if handoff is None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"The '{payload.phase}' review has no ready Writer handoff; "
                "run review-open before delegating the Reviewer"
            ),
        )
    current_fingerprint = generation_fingerprint(db, generation.id)
    if handoff.get("fingerprint") != current_fingerprint:
        raise HTTPException(
            status_code=409,
            detail="Pages changed after the review handoff was opened",
        )
    _assert_review_scope(payload.phase, paths, handoff)
    checkpoint = {
        "phase": payload.phase,
        "attempt": handoff["attempt"],
        "status": payload.status,
        "paths": paths,
        "focusPaths": _plan_focus_paths(payload, paths),
        "summary": payload.summary.strip(),
        "findings": (payload.findings or "").strip(),
        "fingerprint": current_fingerprint,
    }
    checkpoints.append(checkpoint)
    review["checkpoints"] = checkpoints
    _save_review(db, generation, review)
    return review_state(generation, phase=payload.phase)


def review_state(generation: WikiGeneration, *, phase: str) -> dict:
    """Return the latest durable verdict for one review phase."""
    review = (generation.ext or {}).get(QUALITY_REVIEW_EXT_KEY) or {}
    checkpoints = list(review.get("checkpoints") or [])
    handoffs = list(review.get("handoffs") or [])
    checkpoint = _latest(checkpoints, phase)
    ready = _ready_handoff(handoffs, checkpoints, phase)
    if ready is not None:
        state = _state(generation, phase, "ready", handoff=ready)
        return _with_effective_plan(state, checkpoints, handoffs)
    if checkpoint is not None:
        state = _state(
            generation,
            phase,
            str(checkpoint["status"]),
            handoff=_latest(handoffs, phase),
            review=checkpoint,
        )
        return _with_effective_plan(state, checkpoints, handoffs)
    return _with_effective_plan(
        _state(generation, phase, "not_started"), checkpoints, handoffs
    )


def quality_gate_reason(generation: WikiGeneration, pages: Sequence[PageSource]) -> str:
    """Return the reason a required review trail cannot publish, if any."""
    review = (generation.ext or {}).get(QUALITY_REVIEW_EXT_KEY) or {}
    if not review.get("required"):
        return ""

    checkpoints = list(review.get("checkpoints") or [])
    handoffs = list(review.get("handoffs") or [])
    plan = _effective_plan(checkpoints)
    if plan is None or plan.get("status") != "passed":
        return "full rebuild needs a passed plan review before publication"

    amendment = _latest(checkpoints, PLAN_AMENDMENT_PHASE)
    amendment_handoff = _latest(handoffs, PLAN_AMENDMENT_PHASE)
    if amendment_handoff is not None and (
        amendment is None or amendment.get("status") != "passed"
    ):
        return "full rebuild has an unresolved plan amendment"

    planned_paths = _path_keys(plan.get("paths") or [])
    focus_paths = _path_keys(plan.get("focusPaths") or [])
    actual_paths = _path_keys(page.path for page in pages)
    if not planned_paths or planned_paths != actual_paths:
        return (
            "the passed plan review does not match the pages written for this version"
        )
    if not focus_paths or not focus_paths.issubset(planned_paths):
        return "the passed plan review does not identify valid core focus pages"
    if review_policy(generation) == PLAN_ONLY_REVIEW_POLICY:
        return ""

    qa = _latest(checkpoints, "qa")
    if qa is None:
        return "full rebuild needs a final QA review before publication"
    if not focus_paths.issubset(_path_keys(qa.get("paths") or [])):
        return "final QA did not verify every core focus page from the passed plan"
    final = qa if qa.get("status") == "passed" else _latest(checkpoints, "recheck")
    if final is None or final.get("status") != "passed":
        return "final QA requested changes but the one allowed recheck did not pass"

    if final.get("fingerprint") != pages_fingerprint(pages):
        return "pages changed after the latest passed quality review; run QA again"
    return ""


def review_policy(generation: WikiGeneration) -> str:
    """Return the persisted policy, preserving QA for generations created earlier."""
    review = (generation.ext or {}).get(QUALITY_REVIEW_EXT_KEY) or {}
    return str(review.get("policy") or PLAN_AND_QA_REVIEW_POLICY)


def generation_fingerprint(db: Session, generation_id: int) -> str:
    """Fingerprint the generation's page bodies using their stable identities."""
    pages = []
    for content in (
        db.query(WikiContent).filter(WikiContent.generation_id == generation_id).all()
    ):
        path = page_path_of(content)
        if path:
            pages.append(
                PageSource(path=path, title=content.title, content=content.content)
            )
    return pages_fingerprint(pages)


def _generation_paths(db: Session, generation_id: int) -> set[str]:
    paths = set()
    for content in (
        db.query(WikiContent).filter(WikiContent.generation_id == generation_id).all()
    ):
        path = page_path_of(content)
        if path:
            paths.add(collation_key(path))
    return paths


def writing_progress(db: Session, generation: WikiGeneration) -> dict | None:
    """Return page-level progress derived from the passed Plan and stored pages."""
    review = (generation.ext or {}).get(QUALITY_REVIEW_EXT_KEY) or {}
    plan = _effective_plan(list(review.get("checkpoints") or []))
    if plan is None or plan.get("status") != "passed":
        return None

    planned = _path_keys(plan.get("paths") or [])
    written = _generation_paths(db, generation.id)
    return {
        "plannedPaths": sorted(planned, key=collation_key),
        "writtenPaths": sorted(written, key=collation_key),
        "missingPaths": sorted(planned - written, key=collation_key),
        "unexpectedPaths": sorted(written - planned, key=collation_key),
    }


def pages_fingerprint(pages: Sequence[PageSource]) -> str:
    """Return a deterministic content fingerprint independent of write order."""
    digest = hashlib.sha256()
    for page in sorted(pages, key=lambda item: collation_key(item.path)):
        digest.update(page.path.encode())
        digest.update(b"\0")
        digest.update(page.title.encode())
        digest.update(b"\0")
        digest.update(page.content.encode())
        digest.update(b"\0")
    return digest.hexdigest()


def _latest(checkpoints: list[dict], phase: str) -> dict | None:
    for checkpoint in reversed(checkpoints):
        if checkpoint.get("phase") == phase:
            return checkpoint
    return None


def _review_matches(existing: dict, checkpoint: dict) -> bool:
    return all(existing.get(key) == value for key, value in checkpoint.items())


def _required_review(generation: WikiGeneration) -> dict:
    review = dict((generation.ext or {}).get(QUALITY_REVIEW_EXT_KEY) or {})
    if not review.get("required"):
        raise HTTPException(
            status_code=409,
            detail="This generation does not require a quality review",
        )
    return review


def _save_review(db: Session, generation: WikiGeneration, review: dict) -> None:
    ext = dict(generation.ext or {})
    ext[QUALITY_REVIEW_EXT_KEY] = review
    generation.ext = ext
    flag_modified(generation, "ext")
    db.commit()


def _ready_handoff(
    handoffs: list[dict], checkpoints: list[dict], phase: str
) -> dict | None:
    handoff = _latest(handoffs, phase)
    if handoff is None:
        return None
    consumed = any(
        item.get("phase") == phase and item.get("attempt") == handoff.get("attempt")
        for item in checkpoints
    )
    return None if consumed else handoff


def _handoff_matches(existing: dict, candidate: dict) -> bool:
    return all(existing.get(key) == value for key, value in candidate.items())


def _assert_open_allowed(
    checkpoints: list[dict], handoffs: list[dict], phase: str
) -> None:
    plan = _latest(checkpoints, "plan")
    qa = _latest(checkpoints, "qa")
    current = _latest(checkpoints, phase)
    if phase == "plan":
        if current is None:
            return
        if current.get("attempt") == 1 and current.get("status") == "changes_requested":
            return
        raise HTTPException(status_code=409, detail="Plan review is already closed")
    if phase == PLAN_AMENDMENT_PHASE:
        if plan is None or plan.get("status") != "passed":
            raise HTTPException(
                status_code=409,
                detail="A Plan amendment is allowed only after the plan review passes",
            )
        if qa is not None or _latest(handoffs, "qa") is not None:
            raise HTTPException(
                status_code=409,
                detail="A Plan amendment is not allowed after QA has started",
            )
        if current is None:
            return
        if current.get("attempt") == 1 and current.get("status") == "changes_requested":
            return
        raise HTTPException(status_code=409, detail="Plan amendment is already closed")
    if phase == "qa":
        if plan is None or plan.get("status") != "passed":
            raise HTTPException(
                status_code=409,
                detail="QA is allowed only after the plan review passes",
            )
        amendment = _latest(checkpoints, PLAN_AMENDMENT_PHASE)
        amendment_handoff = _latest(handoffs, PLAN_AMENDMENT_PHASE)
        if amendment_handoff is not None and (
            amendment is None or amendment.get("status") != "passed"
        ):
            raise HTTPException(
                status_code=409,
                detail="QA is allowed only after the Plan amendment passes",
            )
        if current is not None:
            raise HTTPException(status_code=409, detail="QA review is already closed")
    if phase == "recheck" and (qa is None or qa.get("status") != "changes_requested"):
        raise HTTPException(
            status_code=409,
            detail="A recheck is allowed only after QA requests changes",
        )
    if phase == "recheck" and current is not None:
        raise HTTPException(status_code=409, detail="Recheck is already closed")


def _assert_findings(payload: WikiGenerationReviewRequest) -> None:
    findings = (payload.findings or "").strip()
    if payload.status == "changes_requested" and not findings:
        raise HTTPException(
            status_code=400,
            detail="changes_requested requires actionable findings",
        )
    if payload.status == "passed" and findings:
        raise HTTPException(
            status_code=400,
            detail="passed review must not include unresolved findings",
        )


def _assert_handoff_scope(
    db: Session,
    generation: WikiGeneration,
    phase: str,
    paths: list[str],
) -> None:
    if phase in {"plan", PLAN_AMENDMENT_PHASE}:
        return
    actual_paths = _generation_paths(db, generation.id)
    supplied_paths = _path_keys(paths)
    if phase == "qa" and supplied_paths != actual_paths:
        raise HTTPException(
            status_code=400,
            detail="QA handoff paths must match every page currently written",
        )
    if phase == "qa":
        review = (generation.ext or {}).get(QUALITY_REVIEW_EXT_KEY) or {}
        plan = _effective_plan(list(review.get("checkpoints") or []))
        planned_paths = _path_keys((plan or {}).get("paths") or [])
        if actual_paths != planned_paths:
            missing = sorted(planned_paths - actual_paths, key=collation_key)
            unexpected = sorted(actual_paths - planned_paths, key=collation_key)
            raise HTTPException(
                status_code=400,
                detail=(
                    "QA requires the written page set to exactly match the passed "
                    f"Plan; missing={missing}, unexpected={unexpected}"
                ),
            )
    if phase == "recheck" and not supplied_paths.issubset(actual_paths):
        raise HTTPException(
            status_code=400,
            detail="Recheck handoff paths must identify pages currently written",
        )


def _assert_review_scope(phase: str, paths: list[str], handoff: dict) -> None:
    reviewed = _path_keys(paths)
    handed_off = _path_keys(handoff.get("paths") or [])
    if phase in {"plan", PLAN_AMENDMENT_PHASE} and reviewed != handed_off:
        raise HTTPException(
            status_code=400,
            detail="Plan verdict paths must match the persisted Plan handoff",
        )
    if phase == "qa" and reviewed != handed_off:
        raise HTTPException(
            status_code=400,
            detail="QA verdict must cover every page in the persisted QA handoff",
        )
    if not reviewed.issubset(handed_off):
        raise HTTPException(
            status_code=400,
            detail="Reviewed paths must belong to the persisted handoff scope",
        )
    if phase == "recheck" and not handed_off.issubset(reviewed):
        raise HTTPException(
            status_code=400,
            detail="Recheck verdict must cover every repaired handoff path",
        )


def _state(
    generation: WikiGeneration,
    phase: str,
    state: str,
    *,
    handoff: dict | None = None,
    review: dict | None = None,
) -> dict:
    subject = review or handoff or {}
    result = {
        "generationId": generation.id,
        "phase": phase,
        "state": state,
        "attempt": subject.get("attempt"),
        "reviewPolicy": review_policy(generation),
        "nextAction": _next_action(
            phase,
            state,
            subject.get("attempt"),
            review_policy(generation),
        ),
    }
    if handoff is not None:
        result["handoff"] = handoff
    if review is not None:
        result["review"] = review
    return result


def _with_effective_plan(
    state: dict, checkpoints: list[dict], handoffs: list[dict]
) -> dict:
    """Attach the current authoritative page ownership without replacing history."""
    if state["phase"] == PLAN_AMENDMENT_PHASE and state["state"] == "not_started":
        plan = _latest(checkpoints, "plan")
        state["nextAction"] = (
            "continue_writing"
            if plan is not None and plan.get("status") == "passed"
            else "complete_plan_review_first"
        )
    plan = _effective_plan(checkpoints)
    if plan is None:
        return state
    amendment = _latest(checkpoints, PLAN_AMENDMENT_PHASE)
    phase = (
        PLAN_AMENDMENT_PHASE
        if amendment is not None and amendment.get("status") == "passed"
        else "plan"
    )
    handoff = _latest(handoffs, phase) or {}
    state["effectivePlan"] = {
        "phase": phase,
        "paths": plan.get("paths") or [],
        "focusPaths": plan.get("focusPaths") or [],
        "writingPlan": handoff.get("writingPlan"),
    }
    return state


def _normalized_writing_plan(
    payload: WikiGenerationReviewOpenRequest,
    planned_paths: list[str],
) -> dict | None:
    """Validate and normalize page ownership carried by a Plan handoff."""
    if payload.phase not in {"plan", PLAN_AMENDMENT_PHASE}:
        if payload.writing_plan is not None:
            raise HTTPException(
                status_code=400,
                detail="writing_plan is valid only for a Plan handoff or amendment",
            )
        return None

    plan = payload.writing_plan or WikiWritingPlan(
        mode="coordinator",
        coordinator_paths=planned_paths,
    )
    coordinator_paths = _normalized_optional_paths(plan.coordinator_paths)
    packages = []
    assigned: list[str] = list(coordinator_paths)
    package_ids: set[str] = set()
    for package in plan.work_packages:
        if package.id in package_ids:
            raise HTTPException(
                status_code=400,
                detail=f"Duplicate Work Package id: {package.id}",
            )
        package_ids.add(package.id)
        package_paths = _normalized_optional_paths(package.paths)
        packages.append({"id": package.id, "paths": package_paths})
        assigned.extend(package_paths)

    assigned_keys = [collation_key(path) for path in assigned]
    duplicates = sorted(
        {path for path in assigned_keys if assigned_keys.count(path) > 1}
    )
    if duplicates:
        raise HTTPException(
            status_code=400,
            detail=f"Writing Plan assigns pages more than once: {duplicates}",
        )

    planned = _path_keys(planned_paths)
    assigned_set = set(assigned_keys)
    if assigned_set != planned:
        missing = sorted(planned - assigned_set, key=collation_key)
        unknown = sorted(assigned_set - planned, key=collation_key)
        raise HTTPException(
            status_code=400,
            detail=(
                "Writing Plan ownership must exactly match planned paths; "
                f"missing={missing}, unknown={unknown}"
            ),
        )
    if plan.mode == "coordinator" and packages:
        raise HTTPException(
            status_code=400,
            detail="Coordinator writing mode cannot define Work Packages",
        )
    if plan.mode == "scoped" and not packages:
        raise HTTPException(
            status_code=400,
            detail="Scoped writing mode requires at least one Work Package",
        )
    language = plan.language.strip() if plan.language else None
    if plan.mode == "scoped" and not language:
        raise HTTPException(
            status_code=400,
            detail="Scoped writing mode requires an output language",
        )
    result = {
        "mode": plan.mode,
        "coordinatorPaths": coordinator_paths,
        "workPackages": packages,
    }
    if language:
        result["language"] = language
    return result


def _normalized_optional_paths(paths: list[str]) -> list[str]:
    """Normalize an ownership path list while allowing an empty collection."""
    if not paths:
        return []
    return _normalized_paths(paths)


def _next_action(phase: str, state: str, attempt: object, policy: str) -> str:
    if phase == PLAN_AMENDMENT_PHASE and state == "not_started":
        return "complete_plan_review_first"
    if policy == PLAN_ONLY_REVIEW_POLICY and phase != "plan" and state == "not_started":
        return "not_required"
    if state == "not_started":
        return f"open_{phase}_review"
    if state == "ready":
        return "review_handoff_and_submit_verdict"
    if phase in {"plan", PLAN_AMENDMENT_PHASE} and state == "passed":
        if policy == PLAN_ONLY_REVIEW_POLICY:
            return "write_pages_then_complete"
        return "write_pages_then_open_qa"
    if phase in {"plan", PLAN_AMENDMENT_PHASE} and state == "changes_requested":
        subject = "plan" if phase == "plan" else "plan_amendment"
        return (
            f"revise_{subject}_then_open_{subject}"
            if attempt == 1
            else "fail_generation"
        )
    if phase == "qa" and state == "passed":
        return "complete_generation"
    if phase == "qa" and state == "changes_requested":
        return "repair_pages_then_open_recheck"
    if phase == "recheck" and state == "passed":
        return "complete_generation"
    return "fail_generation"


def _plan_focus_paths(
    payload: WikiGenerationReviewRequest, planned_paths: list[str]
) -> list[str]:
    if payload.phase not in {"plan", PLAN_AMENDMENT_PHASE}:
        return []
    if payload.status == "changes_requested" and not payload.focus_paths:
        return []
    if not payload.focus_paths:
        if payload.phase == "plan":
            raise HTTPException(
                status_code=400,
                detail="A passed plan review requires at least one core focus path",
            )
        return []
    focus_paths = _normalized_paths(payload.focus_paths)
    unknown = _path_keys(focus_paths) - _path_keys(planned_paths)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail="Core focus paths must also be present in the reviewed plan paths",
        )
    return focus_paths


def _effective_plan(checkpoints: list[dict]) -> dict | None:
    """Return the passed Plan plus its one passed additive amendment, if any."""
    plan = _latest(checkpoints, "plan")
    if plan is None or plan.get("status") != "passed":
        return None
    amendment = _latest(checkpoints, PLAN_AMENDMENT_PHASE)
    if amendment is None or amendment.get("status") != "passed":
        return plan
    effective = dict(amendment)
    effective["focusPaths"] = sorted(
        _path_keys(plan.get("focusPaths") or [])
        | _path_keys(amendment.get("focusPaths") or []),
        key=collation_key,
    )
    return effective


def _assert_additive_amendment_scope(
    db: Session, generation: WikiGeneration, candidate_paths: list[str]
) -> None:
    review = (generation.ext or {}).get(QUALITY_REVIEW_EXT_KEY) or {}
    plan = _latest(list(review.get("checkpoints") or []), "plan") or {}
    original = _path_keys(plan.get("paths") or [])
    candidate = _path_keys(candidate_paths)
    if not original.issubset(candidate) or candidate == original:
        raise HTTPException(
            status_code=400,
            detail="Plan amendment must add paths without removing planned pages",
        )
    written = _generation_paths(db, generation.id)
    if not written.issubset(candidate):
        raise HTTPException(
            status_code=400,
            detail="Plan amendment must retain every page already written",
        )
    if written & (candidate - original):
        raise HTTPException(
            status_code=400,
            detail="Plan amendment must be opened before writing its added pages",
        )


def _normalized_paths(paths: list[str]) -> list[str]:
    if not paths:
        raise HTTPException(
            status_code=400, detail="At least one reviewed path is required"
        )
    normalized = []
    for path in paths:
        try:
            normalized.append(normalize_page_path(path))
        except InvalidPagePath as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        assert_unique_within_version(normalized)
    except InvalidPagePath as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return sorted(normalized, key=collation_key)


def _path_keys(paths: Iterable[str]) -> set[str]:
    """Compare persisted page paths using the database's collation semantics."""
    return {collation_key(path) for path in paths}
