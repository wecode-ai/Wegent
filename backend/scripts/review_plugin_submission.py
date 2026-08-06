#!/usr/bin/env python3
"""List and review Marketplace V2 plugin submissions (approve / reject).

Community "publish to marketplace" submissions land in plugin_submissions with
status=pending after scan. Use this script for local/ops review until an admin
UI exists.

Examples:
  cd backend
  uv run python scripts/review_plugin_submission.py list
  uv run python scripts/review_plugin_submission.py approve --submission-id 12
  uv run python scripts/review_plugin_submission.py approve --slug dev-tools
  uv run python scripts/review_plugin_submission.py reject --submission-id 12 \\
    --note "Missing description"
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.plugin_marketplace import Plugin, PluginSubmission  # noqa: E402
from app.services.plugin_marketplace_service import (  # noqa: E402
    plugin_marketplace_service,
)
from shared.models.db import User  # noqa: E402


def _resolve_reviewer_user_id(db: Session, reviewer_user_id: int | None) -> int:
    if reviewer_user_id is not None:
        user = db.get(User, reviewer_user_id)
        if not user:
            raise SystemExit(f"Reviewer user id {reviewer_user_id} not found")
        return user.id
    admin = db.query(User).filter(User.role == "admin").order_by(User.id.asc()).first()
    if not admin:
        raise SystemExit("No admin user found; pass --reviewer-user-id explicitly")
    return admin.id


def _find_pending_submission_id(db: Session, *, slug: str) -> int:
    rows = (
        db.query(PluginSubmission)
        .join(Plugin, Plugin.id == PluginSubmission.plugin_id)
        .filter(
            Plugin.slug == slug,
            PluginSubmission.status == "pending",
        )
        .order_by(PluginSubmission.submitted_at.desc())
        .all()
    )
    if not rows:
        raise SystemExit(f"No pending submission found for slug '{slug}'")
    if len(rows) > 1:
        ids = ", ".join(str(row.id) for row in rows)
        raise SystemExit(
            f"Multiple pending submissions for slug '{slug}' "
            f"({ids}); pass --submission-id"
        )
    return rows[0].id


def _submission_payload(db: Session, item) -> dict:
    plugin = db.get(Plugin, item.pluginId)
    return {
        "submissionId": item.id,
        "pluginId": item.pluginId,
        "slug": plugin.slug if plugin else None,
        "displayName": plugin.display_name if plugin else None,
        "visibility": plugin.visibility if plugin else None,
        "pluginStatus": plugin.status if plugin else None,
        "releaseId": item.releaseId,
        "purpose": item.purpose,
        "status": item.status,
        "reviewNote": item.reviewNote,
        "submittedAt": item.submittedAt.isoformat() if item.submittedAt else None,
        "reviewedAt": item.reviewedAt.isoformat() if item.reviewedAt else None,
    }


def cmd_list(db: Session, *, status: str | None) -> int:
    response = plugin_marketplace_service.list_submissions(db, status=status)
    payload = [_submission_payload(db, item) for item in response.items]
    print(
        json.dumps(
            {"items": payload, "total": len(payload)}, ensure_ascii=False, indent=2
        )
    )
    return 0


def cmd_review(
    db: Session,
    *,
    approved: bool,
    submission_id: int | None,
    slug: str | None,
    reviewer_user_id: int | None,
    note: str,
) -> int:
    if submission_id is None and not slug:
        raise SystemExit("Pass --submission-id or --slug")
    if submission_id is not None and slug:
        raise SystemExit("Pass only one of --submission-id or --slug")
    resolved_id = (
        submission_id
        if submission_id is not None
        else _find_pending_submission_id(db, slug=slug or "")
    )
    reviewer_id = _resolve_reviewer_user_id(db, reviewer_user_id)
    try:
        item = plugin_marketplace_service.review_submission(
            db,
            reviewer_user_id=reviewer_id,
            submission_id=resolved_id,
            approved=approved,
            note=note,
        )
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        raise SystemExit(f"Review failed ({exc.status_code}): {detail}") from exc
    print(
        json.dumps(
            {
                "reviewerUserId": reviewer_id,
                "approved": approved,
                "submission": _submission_payload(db, item),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Review Marketplace V2 plugin submissions"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List submissions")
    list_parser.add_argument(
        "--status",
        default="pending",
        help="Filter by submission status (default: pending; use '' for all)",
    )

    for name, help_text in (
        ("approve", "Approve a pending submission and publish the release"),
        ("reject", "Reject a pending submission"),
    ):
        action = subparsers.add_parser(name, help=help_text)
        action.add_argument("--submission-id", type=int)
        action.add_argument(
            "--slug", help="Plugin slug with exactly one pending submission"
        )
        action.add_argument(
            "--reviewer-user-id",
            type=int,
            help="Reviewer user id (default: first admin user)",
        )
        action.add_argument("--note", default="", help="Optional review note")

    args = parser.parse_args()
    with SessionLocal() as db:
        if args.command == "list":
            status = args.status.strip() or None
            return cmd_list(db, status=status)
        return cmd_review(
            db,
            approved=args.command == "approve",
            submission_id=args.submission_id,
            slug=args.slug,
            reviewer_user_id=args.reviewer_user_id,
            note=args.note,
        )


if __name__ == "__main__":
    raise SystemExit(main())
