# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GitHub Webhook endpoint for receiving CI/CD events.
Handles check_run and workflow_run events to resume WAITING subtasks.
"""

import hashlib
import hmac
import json
import logging
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.services.async_resume_service import async_resume_service

logger = logging.getLogger(__name__)

router = APIRouter()


def verify_github_signature(
    payload: bytes, signature: Optional[str], secret: str
) -> bool:
    """Verify GitHub webhook signature using HMAC-SHA256."""
    if not secret:
        # If no secret configured, skip verification (not recommended for production)
        logger.warning("GitHub webhook secret not configured, skipping signature verification")
        return True

    if not signature:
        return False

    if not signature.startswith("sha256="):
        return False

    expected_signature = "sha256=" + hmac.new(
        secret.encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(signature, expected_signature)


def extract_github_event_info(event_type: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Extract relevant information from GitHub webhook payload.

    Returns:
        Dict with repo, branch, status, conclusion, and raw payload, or None if not a relevant event.
    """
    if event_type == "check_run":
        check_run = payload.get("check_run", {})
        action = payload.get("action")

        # Only process completed check runs
        if action != "completed":
            return None

        # Extract repository info
        repo = payload.get("repository", {})
        repo_full_name = repo.get("full_name", "")

        # Extract branch info from check_run
        head_branch = check_run.get("check_suite", {}).get("head_branch", "")

        return {
            "repo": repo_full_name,
            "branch": head_branch,
            "status": check_run.get("status"),
            "conclusion": check_run.get("conclusion"),
            "event_type": "check_run",
            "name": check_run.get("name"),
            "html_url": check_run.get("html_url"),
            "raw_payload": payload,
        }

    elif event_type == "workflow_run":
        workflow_run = payload.get("workflow_run", {})
        action = payload.get("action")

        # Only process completed workflow runs
        if action != "completed":
            return None

        repo = payload.get("repository", {})
        repo_full_name = repo.get("full_name", "")
        head_branch = workflow_run.get("head_branch", "")

        return {
            "repo": repo_full_name,
            "branch": head_branch,
            "status": workflow_run.get("status"),
            "conclusion": workflow_run.get("conclusion"),
            "event_type": "workflow_run",
            "name": workflow_run.get("name"),
            "html_url": workflow_run.get("html_url"),
            "raw_payload": payload,
        }

    elif event_type == "pull_request":
        pr = payload.get("pull_request", {})
        action = payload.get("action")

        # Process PR events that might be relevant
        if action not in ["opened", "synchronize", "closed", "merged"]:
            return None

        repo = payload.get("repository", {})
        repo_full_name = repo.get("full_name", "")
        head_branch = pr.get("head", {}).get("ref", "")

        return {
            "repo": repo_full_name,
            "branch": head_branch,
            "status": "completed" if action in ["closed", "merged"] else "in_progress",
            "conclusion": "success" if pr.get("merged") else action,
            "event_type": "pull_request",
            "name": f"PR #{pr.get('number')}: {pr.get('title', '')}",
            "html_url": pr.get("html_url"),
            "raw_payload": payload,
        }

    return None


@router.post("/github")
async def github_webhook(
    request: Request,
    x_hub_signature_256: Optional[str] = Header(None, alias="X-Hub-Signature-256"),
    x_github_event: Optional[str] = Header(None, alias="X-GitHub-Event"),
    db: Session = Depends(get_db),
):
    """
    Handle GitHub webhook events.

    Supported events:
    - check_run (completed): CI check completion
    - workflow_run (completed): GitHub Actions workflow completion
    - pull_request: PR events
    """
    # Read raw body for signature verification
    body = await request.body()

    # Verify signature
    if not verify_github_signature(body, x_hub_signature_256, settings.GITHUB_WEBHOOK_SECRET):
        logger.warning("Invalid GitHub webhook signature")
        raise HTTPException(status_code=401, detail="Invalid signature")

    # Parse payload
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        logger.error("Failed to parse GitHub webhook payload")
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    # Log the event
    logger.info(f"Received GitHub webhook: event={x_github_event}")

    # Extract event information
    event_info = extract_github_event_info(x_github_event, payload)

    if not event_info:
        logger.debug(f"Ignoring GitHub event: {x_github_event}")
        return {"status": "ignored", "reason": "Not a relevant event"}

    logger.info(
        f"Processing GitHub event: repo={event_info['repo']}, "
        f"branch={event_info['branch']}, conclusion={event_info['conclusion']}"
    )

    # Try to resume any waiting subtasks
    result = await async_resume_service.resume_from_webhook(
        db=db,
        git_repo=event_info["repo"],
        branch_name=event_info["branch"],
        webhook_payload=event_info["raw_payload"],
        waiting_for="ci_pipeline",
        source="github",
    )

    return {
        "status": "processed",
        "repo": event_info["repo"],
        "branch": event_info["branch"],
        "conclusion": event_info["conclusion"],
        "resumed_subtasks": result.get("resumed_count", 0),
    }
