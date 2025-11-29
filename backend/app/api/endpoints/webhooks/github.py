# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GitHub webhook endpoint for receiving CI events
"""
import hashlib
import hmac
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, HTTPException, Request

from app.api.dependencies import get_db
from app.core.config import settings
from app.models.completion_condition import ConditionStatus, GitPlatform
from app.services.completion_condition import completion_condition_service
from app.services.ci_monitor import ci_monitor_service

logger = logging.getLogger(__name__)

router = APIRouter()


def verify_github_signature(
    payload: bytes,
    signature: Optional[str],
    secret: str,
) -> bool:
    """Verify GitHub webhook signature"""
    if not signature or not secret:
        return False

    if signature.startswith("sha256="):
        signature = signature[7:]
        expected = hmac.new(
            secret.encode("utf-8"),
            payload,
            hashlib.sha256,
        ).hexdigest()
    elif signature.startswith("sha1="):
        signature = signature[5:]
        expected = hmac.new(
            secret.encode("utf-8"),
            payload,
            hashlib.sha1,
        ).hexdigest()
    else:
        return False

    return hmac.compare_digest(signature, expected)


@router.post("")
async def github_webhook(
    request: Request,
    x_hub_signature_256: Optional[str] = Header(None, alias="X-Hub-Signature-256"),
    x_hub_signature: Optional[str] = Header(None, alias="X-Hub-Signature"),
    x_github_event: Optional[str] = Header(None, alias="X-GitHub-Event"),
    x_github_delivery: Optional[str] = Header(None, alias="X-GitHub-Delivery"),
):
    """
    Handle GitHub webhook events for CI monitoring.

    Supported events:
    - check_run: GitHub Actions check runs
    - workflow_run: GitHub Actions workflow runs
    """
    # Read raw body for signature verification
    body = await request.body()

    # Verify signature if secret is configured
    if settings.GITHUB_WEBHOOK_SECRET:
        signature = x_hub_signature_256 or x_hub_signature
        if not verify_github_signature(body, signature, settings.GITHUB_WEBHOOK_SECRET):
            logger.warning(
                f"GitHub webhook signature verification failed for delivery {x_github_delivery}"
            )
            raise HTTPException(status_code=401, detail="Invalid signature")

    # Parse JSON payload
    try:
        payload = await request.json()
    except Exception as e:
        logger.error(f"Failed to parse GitHub webhook payload: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    logger.info(
        f"Received GitHub webhook: event={x_github_event}, delivery={x_github_delivery}"
    )

    # Route to appropriate handler based on event type
    if x_github_event == "check_run":
        await handle_check_run(payload)
    elif x_github_event == "workflow_run":
        await handle_workflow_run(payload)
    elif x_github_event == "ping":
        logger.info("Received GitHub ping event")
        return {"status": "pong"}
    else:
        logger.debug(f"Ignoring GitHub event: {x_github_event}")

    return {"status": "ok"}


async def handle_check_run(payload: Dict[str, Any]):
    """Handle GitHub check_run event"""
    action = payload.get("action")
    check_run = payload.get("check_run", {})
    repository = payload.get("repository", {})

    repo_full_name = repository.get("full_name", "")
    check_name = check_run.get("name", "")
    status = check_run.get("status", "")
    conclusion = check_run.get("conclusion")
    head_sha = check_run.get("head_sha", "")
    head_branch = check_run.get("check_suite", {}).get("head_branch", "")
    html_url = check_run.get("html_url", "")
    external_id = str(check_run.get("id", ""))

    logger.info(
        f"GitHub check_run: repo={repo_full_name}, branch={head_branch}, "
        f"name={check_name}, action={action}, status={status}, conclusion={conclusion}"
    )

    # Only process configured check types
    if settings.CI_CHECK_TYPES:
        check_type_match = any(
            ct.lower() in check_name.lower() for ct in settings.CI_CHECK_TYPES
        )
        if not check_type_match:
            logger.debug(f"Ignoring check_run '{check_name}' - not in configured types")
            return

    # Process based on action
    if action == "created" and status == "in_progress":
        await ci_monitor_service.handle_ci_started(
            repo_full_name=repo_full_name,
            branch_name=head_branch,
            external_id=external_id,
            external_url=html_url,
            git_platform=GitPlatform.GITHUB,
        )
    elif action == "completed":
        if conclusion == "success":
            await ci_monitor_service.handle_ci_success(
                repo_full_name=repo_full_name,
                branch_name=head_branch,
                external_id=external_id,
                git_platform=GitPlatform.GITHUB,
            )
        elif conclusion in ("failure", "cancelled", "timed_out"):
            await ci_monitor_service.handle_ci_failure(
                repo_full_name=repo_full_name,
                branch_name=head_branch,
                external_id=external_id,
                conclusion=conclusion,
                git_platform=GitPlatform.GITHUB,
            )


async def handle_workflow_run(payload: Dict[str, Any]):
    """Handle GitHub workflow_run event"""
    action = payload.get("action")
    workflow_run = payload.get("workflow_run", {})
    repository = payload.get("repository", {})

    repo_full_name = repository.get("full_name", "")
    workflow_name = workflow_run.get("name", "")
    status = workflow_run.get("status", "")
    conclusion = workflow_run.get("conclusion")
    head_branch = workflow_run.get("head_branch", "")
    html_url = workflow_run.get("html_url", "")
    external_id = str(workflow_run.get("id", ""))
    run_number = workflow_run.get("run_number", "")

    logger.info(
        f"GitHub workflow_run: repo={repo_full_name}, branch={head_branch}, "
        f"workflow={workflow_name}, action={action}, status={status}, conclusion={conclusion}"
    )

    # Process based on action and status
    if action == "requested" or (action == "in_progress" and status == "in_progress"):
        await ci_monitor_service.handle_ci_started(
            repo_full_name=repo_full_name,
            branch_name=head_branch,
            external_id=external_id,
            external_url=html_url,
            git_platform=GitPlatform.GITHUB,
        )
    elif action == "completed":
        if conclusion == "success":
            await ci_monitor_service.handle_ci_success(
                repo_full_name=repo_full_name,
                branch_name=head_branch,
                external_id=external_id,
                git_platform=GitPlatform.GITHUB,
            )
        elif conclusion in ("failure", "cancelled", "timed_out"):
            await ci_monitor_service.handle_ci_failure(
                repo_full_name=repo_full_name,
                branch_name=head_branch,
                external_id=external_id,
                conclusion=conclusion,
                git_platform=GitPlatform.GITHUB,
            )
