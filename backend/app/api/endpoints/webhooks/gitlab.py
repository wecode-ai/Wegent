# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GitLab webhook endpoint for receiving CI events
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, HTTPException, Request

from app.core.config import settings
from app.models.completion_condition import GitPlatform
from app.services.ci_monitor import ci_monitor_service

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("")
async def gitlab_webhook(
    request: Request,
    x_gitlab_token: Optional[str] = Header(None, alias="X-Gitlab-Token"),
    x_gitlab_event: Optional[str] = Header(None, alias="X-Gitlab-Event"),
):
    """
    Handle GitLab webhook events for CI monitoring.

    Supported events:
    - Pipeline Hook: GitLab CI/CD pipeline events
    """
    # Verify token if configured
    if settings.GITLAB_WEBHOOK_TOKEN:
        if x_gitlab_token != settings.GITLAB_WEBHOOK_TOKEN:
            logger.warning("GitLab webhook token verification failed")
            raise HTTPException(status_code=401, detail="Invalid token")

    # Parse JSON payload
    try:
        payload = await request.json()
    except Exception as e:
        logger.error(f"Failed to parse GitLab webhook payload: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    object_kind = payload.get("object_kind", "")
    logger.info(f"Received GitLab webhook: event={x_gitlab_event}, kind={object_kind}")

    # Route to appropriate handler based on event type
    if object_kind == "pipeline":
        await handle_pipeline_event(payload)
    elif object_kind == "build":
        await handle_build_event(payload)
    else:
        logger.debug(f"Ignoring GitLab event: {object_kind}")

    return {"status": "ok"}


async def handle_pipeline_event(payload: Dict[str, Any]):
    """Handle GitLab pipeline event"""
    object_attributes = payload.get("object_attributes", {})
    project = payload.get("project", {})

    # Extract pipeline information
    pipeline_id = str(object_attributes.get("id", ""))
    status = object_attributes.get("status", "")
    ref = object_attributes.get("ref", "")  # Branch name
    sha = object_attributes.get("sha", "")
    pipeline_url = object_attributes.get("url", "")

    # Extract project information
    repo_full_name = project.get("path_with_namespace", "")
    git_domain = project.get("web_url", "").split("/")[2] if project.get("web_url") else ""

    logger.info(
        f"GitLab pipeline: repo={repo_full_name}, branch={ref}, "
        f"pipeline_id={pipeline_id}, status={status}"
    )

    # Process based on status
    if status == "running":
        await ci_monitor_service.handle_ci_started(
            repo_full_name=repo_full_name,
            branch_name=ref,
            external_id=pipeline_id,
            external_url=pipeline_url,
            git_platform=GitPlatform.GITLAB,
            git_domain=git_domain,
        )
    elif status == "success":
        await ci_monitor_service.handle_ci_success(
            repo_full_name=repo_full_name,
            branch_name=ref,
            external_id=pipeline_id,
            git_platform=GitPlatform.GITLAB,
        )
    elif status in ("failed", "canceled", "skipped"):
        await ci_monitor_service.handle_ci_failure(
            repo_full_name=repo_full_name,
            branch_name=ref,
            external_id=pipeline_id,
            conclusion=status,
            git_platform=GitPlatform.GITLAB,
        )


async def handle_build_event(payload: Dict[str, Any]):
    """Handle GitLab build/job event"""
    object_attributes = payload.get("object_attributes", {})
    project = payload.get("project", {})

    # Extract build information
    build_id = str(object_attributes.get("id", ""))
    build_name = object_attributes.get("name", "")
    status = object_attributes.get("status", "")
    ref = object_attributes.get("ref", "")
    pipeline_id = str(object_attributes.get("pipeline_id", ""))

    # Extract project information
    repo_full_name = project.get("path_with_namespace", "")

    logger.info(
        f"GitLab build: repo={repo_full_name}, branch={ref}, "
        f"build={build_name}, status={status}"
    )

    # We primarily track pipeline status, but log build events for debugging
    # Individual build failures will be handled when the pipeline fails
