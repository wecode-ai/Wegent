# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GitLab Webhook endpoint for receiving CI/CD pipeline events.
Handles Pipeline Hook events to resume WAITING subtasks.
"""

import json
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.services.async_resume_service import async_resume_service

logger = logging.getLogger(__name__)

router = APIRouter()


def verify_gitlab_token(token: Optional[str], expected_token: str) -> bool:
    """Verify GitLab webhook token."""
    if not expected_token:
        # If no token configured, skip verification (not recommended for production)
        logger.warning("GitLab webhook token not configured, skipping verification")
        return True

    return token == expected_token


def extract_gitlab_event_info(event_type: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Extract relevant information from GitLab webhook payload.

    Returns:
        Dict with repo, branch, status, and raw payload, or None if not a relevant event.
    """
    if event_type == "Pipeline Hook":
        object_attributes = payload.get("object_attributes", {})
        status = object_attributes.get("status")

        # Only process completed pipelines (success, failed, canceled)
        if status not in ["success", "failed", "canceled"]:
            return None

        # Extract project info
        project = payload.get("project", {})
        # Use path_with_namespace as repo identifier (e.g., "group/project")
        repo_path = project.get("path_with_namespace", "")

        # Extract branch info
        ref = object_attributes.get("ref", "")

        return {
            "repo": repo_path,
            "branch": ref,
            "status": status,
            "conclusion": status,
            "event_type": "pipeline",
            "pipeline_id": object_attributes.get("id"),
            "web_url": project.get("web_url"),
            "raw_payload": payload,
        }

    elif event_type == "Merge Request Hook":
        object_attributes = payload.get("object_attributes", {})
        action = object_attributes.get("action")

        # Process MR events that might be relevant
        if action not in ["open", "update", "merge", "close"]:
            return None

        project = payload.get("project", {})
        repo_path = project.get("path_with_namespace", "")
        source_branch = object_attributes.get("source_branch", "")

        return {
            "repo": repo_path,
            "branch": source_branch,
            "status": "merged" if action == "merge" else action,
            "conclusion": action,
            "event_type": "merge_request",
            "mr_iid": object_attributes.get("iid"),
            "web_url": object_attributes.get("url"),
            "raw_payload": payload,
        }

    elif event_type == "Job Hook":
        build_status = payload.get("build_status")

        # Only process completed jobs
        if build_status not in ["success", "failed", "canceled"]:
            return None

        # Extract project info
        project_name = payload.get("project_name", "")
        ref = payload.get("ref", "")

        return {
            "repo": project_name,
            "branch": ref,
            "status": build_status,
            "conclusion": build_status,
            "event_type": "job",
            "build_id": payload.get("build_id"),
            "raw_payload": payload,
        }

    return None


@router.post("/gitlab")
async def gitlab_webhook(
    request: Request,
    x_gitlab_token: Optional[str] = Header(None, alias="X-Gitlab-Token"),
    x_gitlab_event: Optional[str] = Header(None, alias="X-Gitlab-Event"),
    db: Session = Depends(get_db),
):
    """
    Handle GitLab webhook events.

    Supported events:
    - Pipeline Hook: CI/CD pipeline completion
    - Merge Request Hook: MR events
    - Job Hook: Individual job completion
    """
    # Verify token
    if not verify_gitlab_token(x_gitlab_token, settings.GITLAB_WEBHOOK_TOKEN):
        logger.warning("Invalid GitLab webhook token")
        raise HTTPException(status_code=401, detail="Invalid token")

    # Read and parse body
    body = await request.body()
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        logger.error("Failed to parse GitLab webhook payload")
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    # Log the event
    logger.info(f"Received GitLab webhook: event={x_gitlab_event}")

    # Extract event information
    event_info = extract_gitlab_event_info(x_gitlab_event, payload)

    if not event_info:
        logger.debug(f"Ignoring GitLab event: {x_gitlab_event}")
        return {"status": "ignored", "reason": "Not a relevant event"}

    logger.info(
        f"Processing GitLab event: repo={event_info['repo']}, "
        f"branch={event_info['branch']}, status={event_info['status']}"
    )

    # Try to resume any waiting subtasks
    result = await async_resume_service.resume_from_webhook(
        db=db,
        git_repo=event_info["repo"],
        branch_name=event_info["branch"],
        webhook_payload=event_info["raw_payload"],
        waiting_for="ci_pipeline",
        source="gitlab",
    )

    return {
        "status": "processed",
        "repo": event_info["repo"],
        "branch": event_info["branch"],
        "conclusion": event_info["conclusion"],
        "resumed_subtasks": result.get("resumed_count", 0),
    }
