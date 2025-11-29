# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GitHub Webhook endpoint for receiving CI events
"""

import hashlib
import hmac
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.schemas.completion_condition import (
    GitHubCheckRunEvent,
    GitHubWorkflowRunEvent,
    GitPlatform,
)
from app.services.ci_monitor_service import get_ci_monitor_service

logger = logging.getLogger(__name__)

router = APIRouter()


def verify_github_signature(
    payload: bytes, signature: str, secret: str
) -> bool:
    """Verify GitHub webhook signature (X-Hub-Signature-256)"""
    if not signature or not secret:
        return False

    expected_signature = "sha256=" + hmac.new(
        secret.encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(expected_signature, signature)


def extract_repo_info(payload: Dict[str, Any]) -> tuple:
    """Extract repository full name and git domain from payload"""
    repository = payload.get("repository", {})
    full_name = repository.get("full_name", "")

    # Extract domain from html_url
    html_url = repository.get("html_url", "")
    if html_url:
        # Parse domain from URL like https://github.com/owner/repo
        parts = html_url.split("/")
        if len(parts) >= 3:
            git_domain = parts[2]  # github.com or enterprise domain
        else:
            git_domain = "github.com"
    else:
        git_domain = "github.com"

    return full_name, git_domain


def extract_branch_from_check_run(payload: Dict[str, Any]) -> str:
    """Extract branch name from check_run event"""
    check_run = payload.get("check_run", {})
    check_suite = check_run.get("check_suite", {})

    # Try head_branch first
    branch = check_suite.get("head_branch")
    if branch:
        return branch

    # Fallback to pull_requests
    pull_requests = check_run.get("pull_requests", [])
    if pull_requests:
        return pull_requests[0].get("head", {}).get("ref", "")

    return ""


def extract_branch_from_workflow_run(payload: Dict[str, Any]) -> str:
    """Extract branch name from workflow_run event"""
    workflow_run = payload.get("workflow_run", {})
    return workflow_run.get("head_branch", "")


@router.post("/github")
async def github_webhook(
    request: Request,
    x_hub_signature_256: str = Header(None, alias="X-Hub-Signature-256"),
    x_github_event: str = Header(None, alias="X-GitHub-Event"),
    db: Session = Depends(get_db),
):
    """
    Receive GitHub webhook events for CI monitoring.

    Supported events:
    - check_run (completed): For GitHub Actions check results
    - workflow_run (completed): For workflow completion status
    """
    # Read raw body for signature verification
    body = await request.body()

    # Verify signature if secret is configured
    webhook_secret = getattr(settings, "GITHUB_WEBHOOK_SECRET", None)
    if webhook_secret and x_hub_signature_256:
        if not verify_github_signature(body, x_hub_signature_256, webhook_secret):
            logger.warning("Invalid GitHub webhook signature")
            raise HTTPException(status_code=401, detail="Invalid signature")

    # Parse payload
    try:
        payload = await request.json()
    except Exception as e:
        logger.error(f"Failed to parse GitHub webhook payload: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    logger.info(f"Received GitHub webhook event: {x_github_event}")

    # Extract repository info
    repo_full_name, git_domain = extract_repo_info(payload)
    if not repo_full_name:
        logger.warning("No repository info in webhook payload")
        return {"status": "ignored", "reason": "no repository info"}

    ci_monitor = get_ci_monitor_service(db)

    # Handle check_run events
    if x_github_event == "check_run":
        action = payload.get("action")
        if action not in ("created", "completed"):
            return {"status": "ignored", "reason": f"check_run action {action} not handled"}

        check_run = payload.get("check_run", {})
        branch_name = extract_branch_from_check_run(payload)

        if not branch_name:
            logger.warning("No branch name found in check_run event")
            return {"status": "ignored", "reason": "no branch name"}

        # Map status
        status = check_run.get("status", "")
        if status == "queued":
            status = "queued"
        elif status == "in_progress":
            status = "in_progress"
        elif status == "completed":
            status = "completed"

        event = GitHubCheckRunEvent(
            repo_full_name=repo_full_name,
            branch_name=branch_name,
            git_platform=GitPlatform.GITHUB,
            check_run_id=check_run.get("id", 0),
            check_suite_id=check_run.get("check_suite", {}).get("id", 0),
            conclusion=check_run.get("conclusion"),
            status=status,
            name=check_run.get("name", ""),
            html_url=check_run.get("html_url"),
            output=check_run.get("output"),
        )

        updated = await ci_monitor.handle_github_check_run(event)
        return {
            "status": "processed",
            "event_type": "check_run",
            "conditions_updated": len(updated),
        }

    # Handle workflow_run events
    elif x_github_event == "workflow_run":
        action = payload.get("action")
        if action not in ("requested", "in_progress", "completed"):
            return {"status": "ignored", "reason": f"workflow_run action {action} not handled"}

        workflow_run = payload.get("workflow_run", {})
        branch_name = extract_branch_from_workflow_run(payload)

        if not branch_name:
            logger.warning("No branch name found in workflow_run event")
            return {"status": "ignored", "reason": "no branch name"}

        event = GitHubWorkflowRunEvent(
            repo_full_name=repo_full_name,
            branch_name=branch_name,
            git_platform=GitPlatform.GITHUB,
            workflow_run_id=workflow_run.get("id", 0),
            workflow_id=workflow_run.get("workflow_id", 0),
            conclusion=workflow_run.get("conclusion"),
            status=workflow_run.get("status", ""),
            name=workflow_run.get("name", ""),
            html_url=workflow_run.get("html_url"),
            run_attempt=workflow_run.get("run_attempt", 1),
        )

        updated = await ci_monitor.handle_github_workflow_run(event)
        return {
            "status": "processed",
            "event_type": "workflow_run",
            "conditions_updated": len(updated),
        }

    # Ignore other events
    return {"status": "ignored", "reason": f"event {x_github_event} not handled"}
