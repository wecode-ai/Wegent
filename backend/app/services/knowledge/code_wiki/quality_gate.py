# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Review checkpoints required before a coordinated full rebuild is published."""

from __future__ import annotations

import hashlib
from typing import Sequence

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.wiki import WikiContent, WikiGeneration
from app.schemas.wiki import (
    WikiGenerationReviewOpenRequest,
    WikiGenerationReviewRequest,
)
from app.services.knowledge.code_wiki.page_path import (
    InvalidPagePath,
    collation_key,
    normalize_page_path,
)
from app.services.knowledge.code_wiki.projection_plan import PageSource
from app.services.knowledge.code_wiki.version_store import page_path_of

QUALITY_REVIEW_EXT_KEY = "qualityReview"


def require_quality_review(generation: WikiGeneration) -> None:
    """Mark a newly started full rebuild as requiring review checkpoints."""
    ext = dict(generation.ext or {})
    ext[QUALITY_REVIEW_EXT_KEY] = {
        "required": True,
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
    _assert_open_allowed(checkpoints, payload.phase)

    paths = _normalized_paths(payload.paths)
    _assert_handoff_scope(db, generation, payload.phase, paths)
    attempt = 1 + sum(item.get("phase") == payload.phase for item in checkpoints)
    handoff = {
        "phase": payload.phase,
        "attempt": attempt,
        "paths": paths,
        "summary": payload.summary.strip(),
        "handoff": payload.handoff.strip(),
        "fingerprint": generation_fingerprint(db, generation.id),
    }
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
        return _state(generation, phase, "ready", handoff=ready)
    if checkpoint is not None:
        return _state(
            generation,
            phase,
            str(checkpoint["status"]),
            review=checkpoint,
        )
    return _state(generation, phase, "not_started")


def quality_gate_reason(generation: WikiGeneration, pages: Sequence[PageSource]) -> str:
    """Return the reason a required review trail cannot publish, if any."""
    review = (generation.ext or {}).get(QUALITY_REVIEW_EXT_KEY) or {}
    if not review.get("required"):
        return ""

    checkpoints = list(review.get("checkpoints") or [])
    plan = _latest(checkpoints, "plan")
    if plan is None or plan.get("status") != "passed":
        return "full rebuild needs a passed plan review before publication"

    planned_paths = set(plan.get("paths") or [])
    focus_paths = set(plan.get("focusPaths") or [])
    actual_paths = {collation_key(page.path) for page in pages}
    if not planned_paths or not planned_paths.issubset(actual_paths):
        return (
            "the passed plan review does not match the pages written for this version"
        )
    if not focus_paths or not focus_paths.issubset(planned_paths):
        return "the passed plan review does not identify valid core focus pages"

    qa = _latest(checkpoints, "qa")
    if qa is None:
        return "full rebuild needs a final QA review before publication"
    if not focus_paths.issubset(set(qa.get("paths") or [])):
        return "final QA did not verify every core focus page from the passed plan"
    final = qa if qa.get("status") == "passed" else _latest(checkpoints, "recheck")
    if final is None or final.get("status") != "passed":
        return "final QA requested changes but the one allowed recheck did not pass"

    if final.get("fingerprint") != pages_fingerprint(pages):
        return "pages changed after the latest passed quality review; run QA again"
    return ""


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


def _assert_open_allowed(checkpoints: list[dict], phase: str) -> None:
    plan = _latest(checkpoints, "plan")
    qa = _latest(checkpoints, "qa")
    current = _latest(checkpoints, phase)
    if phase == "plan":
        if current is None:
            return
        if current.get("attempt") == 1 and current.get("status") == "changes_requested":
            return
        raise HTTPException(status_code=409, detail="Plan review is already closed")
    if phase == "qa" and (plan is None or plan.get("status") != "passed"):
        raise HTTPException(
            status_code=409,
            detail="QA is allowed only after the plan review passes",
        )
    if phase == "qa" and current is not None:
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
    if phase == "plan":
        return
    actual_paths = _generation_paths(db, generation.id)
    supplied_paths = set(paths)
    if phase == "qa" and supplied_paths != actual_paths:
        raise HTTPException(
            status_code=400,
            detail="QA handoff paths must match every page currently written",
        )
    if phase == "recheck" and not supplied_paths.issubset(actual_paths):
        raise HTTPException(
            status_code=400,
            detail="Recheck handoff paths must identify pages currently written",
        )


def _assert_review_scope(phase: str, paths: list[str], handoff: dict) -> None:
    reviewed = set(paths)
    handed_off = set(handoff.get("paths") or [])
    if phase == "plan" and reviewed != handed_off:
        raise HTTPException(
            status_code=400,
            detail="Plan verdict paths must match the persisted Plan handoff",
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
    subject = handoff or review or {}
    result = {
        "generationId": generation.id,
        "phase": phase,
        "state": state,
        "attempt": subject.get("attempt"),
        "nextAction": _next_action(phase, state, subject.get("attempt")),
    }
    if handoff is not None:
        result["handoff"] = handoff
    if review is not None:
        result["review"] = review
    return result


def _next_action(phase: str, state: str, attempt: object) -> str:
    if state == "not_started":
        return f"open_{phase}_review"
    if state == "ready":
        return "review_handoff_and_submit_verdict"
    if phase == "plan" and state == "passed":
        return "write_pages_then_open_qa"
    if phase == "plan" and state == "changes_requested":
        return "revise_plan_then_open_plan" if attempt == 1 else "fail_generation"
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
    if payload.phase != "plan":
        return []
    if payload.status == "changes_requested" and not payload.focus_paths:
        return []
    focus_paths = _normalized_paths(payload.focus_paths)
    unknown = set(focus_paths) - set(planned_paths)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail="Core focus paths must also be present in the reviewed plan paths",
        )
    return focus_paths


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
    return sorted(set(normalized), key=collation_key)
