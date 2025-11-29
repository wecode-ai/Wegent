# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GitLab Webhook endpoint for receiving CI events
"""

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.schemas.completion_condition import GitLabPipelineEvent, GitPlatform
from app.services.ci_monitor_service import get_ci_monitor_service

logger = logging.getLogger(__name__)

router = APIRouter()


def verify_gitlab_token(token: str, expected_token: str) -> bool:
    """Verify GitLab webhook token (X-Gitlab-Token)"""
    if not expected_token:
        return True  # No token configured, skip verification
    return token == expected_token


def extract_repo_info_gitlab(payload: Dict[str, Any]) -> tuple:
    """Extract repository full name and git domain from GitLab payload"""
    project = payload.get("project", {})
    path_with_namespace = project.get("path_with_namespace", "")

    # Extract domain from web_url
    web_url = project.get("web_url", "")
    if web_url:
        # Parse domain from URL like https://gitlab.com/owner/repo
        parts = web_url.split("/")
        if len(parts) >= 3:
            git_domain = parts[2]  # gitlab.com or self-hosted domain
        else:
            git_domain = "gitlab.com"
    else:
        git_domain = "gitlab.com"

    return path_with_namespace, git_domain


@router.post("/gitlab")
async def gitlab_webhook(
    request: Request,
    x_gitlab_token: str = Header(None, alias="X-Gitlab-Token"),
    x_gitlab_event: str = Header(None, alias="X-Gitlab-Event"),
    db: Session = Depends(get_db),
):
    """
    Receive GitLab webhook events for CI monitoring.

    Supported events:
    - Pipeline Hook: For pipeline status changes
    """
    # Verify token if configured
    webhook_token = getattr(settings, "GITLAB_WEBHOOK_TOKEN", None)
    if webhook_token:
        if not verify_gitlab_token(x_gitlab_token or "", webhook_token):
            logger.warning("Invalid GitLab webhook token")
            raise HTTPException(status_code=401, detail="Invalid token")

    # Parse payload
    try:
        payload = await request.json()
    except Exception as e:
        logger.error(f"Failed to parse GitLab webhook payload: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    logger.info(f"Received GitLab webhook event: {x_gitlab_event}")

    # Determine event type from header or payload
    object_kind = payload.get("object_kind", "")

    # Handle Pipeline events
    if object_kind == "pipeline" or x_gitlab_event == "Pipeline Hook":
        return await _handle_pipeline_event(payload, db)

    # Ignore other events
    return {"status": "ignored", "reason": f"event {object_kind or x_gitlab_event} not handled"}


async def _handle_pipeline_event(payload: Dict[str, Any], db: Session) -> Dict[str, Any]:
    """Handle GitLab Pipeline webhook event"""
    object_attributes = payload.get("object_attributes", {})

    # Extract repository info
    repo_full_name, git_domain = extract_repo_info_gitlab(payload)
    if not repo_full_name:
        logger.warning("No repository info in GitLab webhook payload")
        return {"status": "ignored", "reason": "no repository info"}

    # Extract branch (ref)
    ref = object_attributes.get("ref", "")
    if not ref:
        logger.warning("No ref (branch) in GitLab pipeline event")
        return {"status": "ignored", "reason": "no ref"}

    # Pipeline status
    status = object_attributes.get("status", "")
    pipeline_id = object_attributes.get("id", 0)
    project_id = payload.get("project", {}).get("id", 0)

    # Build web URL
    web_url = payload.get("project", {}).get("web_url", "")
    pipeline_url = f"{web_url}/-/pipelines/{pipeline_id}" if web_url else None

    event = GitLabPipelineEvent(
        repo_full_name=repo_full_name,
        branch_name=ref,
        git_platform=GitPlatform.GITLAB,
        pipeline_id=pipeline_id,
        project_id=project_id,
        status=status,
        ref=ref,
        web_url=pipeline_url,
        source=object_attributes.get("source"),
    )

    ci_monitor = get_ci_monitor_service(db)
    updated = await ci_monitor.handle_gitlab_pipeline(event)

    return {
        "status": "processed",
        "event_type": "pipeline",
        "pipeline_status": status,
        "conditions_updated": len(updated),
    }
