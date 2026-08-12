# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Signed GitHub and GitLab webhooks for task development state."""

import hashlib
import hmac
import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.webhook_secrets import decrypt_webhook_secret
from app.models.project_workflow import (
    ProjectRepositoryBinding,
    ProjectWorkflowAutomation,
)
from app.schemas.project_workflow import (
    ProjectWorkflowAutomationRunView,
    RepositoryProviderEventInput,
    RepositoryProviderEventView,
)
from app.services.project_workflows import project_workflow_service

router = APIRouter()
MAX_CLOCK_SKEW_SECONDS = 300


def _verify_request(
    *,
    db: Session,
    provider: str,
    binding_id: str,
    timestamp: str,
    signature: str,
    body: bytes,
) -> ProjectRepositoryBinding:
    binding = db.get(ProjectRepositoryBinding, binding_id)
    if binding is None or binding.status != "active" or binding.provider != provider:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Repository binding not found")
    if not binding.webhook_secret_ciphertext:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Repository webhook secret is not configured",
        )
    try:
        request_time = datetime.fromtimestamp(int(timestamp), tz=UTC)
    except (ValueError, OSError) as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid webhook timestamp",
        ) from exc
    now = datetime.now(UTC)
    if abs((now - request_time).total_seconds()) > MAX_CLOCK_SKEW_SECONDS:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Webhook timestamp is outside the accepted window",
        )
    secret = decrypt_webhook_secret(binding.webhook_secret_ciphertext)
    supplied = signature.removeprefix("sha256=")
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid webhook signature")
    return binding


def _json_body(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Invalid webhook JSON"
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Webhook JSON must be an object"
        )
    return payload


def _verify_automation_request(
    *,
    automation: ProjectWorkflowAutomation,
    timestamp: str,
    signature: str,
    body: bytes,
) -> None:
    if not automation.webhook_secret_ciphertext:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Workflow automation webhook secret is not configured",
        )
    try:
        request_time = datetime.fromtimestamp(int(timestamp), tz=UTC)
    except (ValueError, OSError) as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid webhook timestamp",
        ) from exc
    if abs((datetime.now(UTC) - request_time).total_seconds()) > MAX_CLOCK_SKEW_SECONDS:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Webhook timestamp is outside the accepted window",
        )
    secret = decrypt_webhook_secret(automation.webhook_secret_ciphertext)
    supplied = signature.removeprefix("sha256=")
    signed = timestamp.encode("utf-8") + b"." + body
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid webhook signature")


def _github_event(
    *,
    event_type: str,
    delivery_id: str,
    payload: dict[str, Any],
) -> RepositoryProviderEventInput:
    pull_request = payload.get("pull_request")
    if not isinstance(pull_request, dict):
        pull_request = {}
    head = pull_request.get("head")
    base = pull_request.get("base")
    head = head if isinstance(head, dict) else {}
    base = base if isinstance(base, dict) else {}
    review = payload.get("review")
    review = review if isinstance(review, dict) else {}
    review_state = str(review.get("state") or "").lower()
    review_decision = (
        "approved"
        if review_state == "approved"
        else "changes_requested" if review_state == "changes_requested" else None
    )
    check = payload.get("check_run")
    check = check if isinstance(check, dict) else {}
    workflow_run = payload.get("workflow_run")
    workflow_run = workflow_run if isinstance(workflow_run, dict) else {}
    check_id = check.get("id") or workflow_run.get("id")
    check_name = check.get("name") or workflow_run.get("name")
    check_status = check.get("status") or workflow_run.get("status")
    check_conclusion = check.get("conclusion") or workflow_run.get("conclusion")
    comment = payload.get("comment")
    comment = comment if isinstance(comment, dict) else {}
    comment_user = comment.get("user") if isinstance(comment.get("user"), dict) else {}
    comment_id = comment.get("id")
    thread_id = comment.get("in_reply_to_id") or comment_id
    review_threads = (
        [
            {
                "id": f"github-review-{thread_id}",
                "commentId": str(comment_id),
                "path": comment.get("path"),
                "line": comment.get("line") or comment.get("original_line"),
                "side": comment.get("side"),
                "author": comment_user.get("login"),
                "body": str(comment.get("body") or ""),
                "url": comment.get("html_url"),
                "status": "open",
                "reviewState": review_decision,
            }
        ]
        if comment_id and event_type == "pull_request_review_comment"
        else []
    )
    checks = (
        [
            {
                "id": str(check_id),
                "name": str(check_name or event_type),
                "status": str(check_status or "pending"),
                "conclusion": str(check_conclusion) if check_conclusion else None,
                "detailsUrl": check.get("details_url") or workflow_run.get("html_url"),
            }
        ]
        if check_id
        else []
    )
    merged = bool(pull_request.get("merged"))
    return RepositoryProviderEventInput(
        provider_event_id=str(
            pull_request.get("id")
            or review.get("id")
            or comment_id
            or check_id
            or delivery_id
        ),
        delivery_id=delivery_id,
        event_type=event_type,
        branch_name=str(head.get("ref") or workflow_run.get("head_branch") or "")
        or None,
        base_branch=str(base.get("ref") or "") or None,
        head_commit=str(head.get("sha") or workflow_run.get("head_sha") or "") or None,
        pull_request_id=str(pull_request.get("id") or "") or None,
        pull_request_number=(
            int(pull_request["number"])
            if isinstance(pull_request.get("number"), int)
            else (
                payload.get("number")
                if isinstance(payload.get("number"), int)
                else None
            )
        ),
        pull_request_url=str(pull_request.get("html_url") or "") or None,
        pull_request_state=(
            "merged" if merged else str(pull_request.get("state") or "") or None
        ),
        draft=bool(pull_request.get("draft")) if pull_request else None,
        mergeable_state=str(pull_request.get("mergeable_state") or "") or None,
        review_decision=review_decision,
        ci_state=(
            "success"
            if check_conclusion == "success"
            else (
                "failure"
                if check_conclusion in {"failure", "cancelled", "timed_out"}
                else None
            )
        ),
        merged_commit=(
            str(pull_request.get("merge_commit_sha") or "") if merged else None
        ),
        checks=checks,
        review_threads=review_threads,
    )


def _gitlab_event(
    *,
    event_type: str,
    delivery_id: str,
    payload: dict[str, Any],
) -> RepositoryProviderEventInput:
    attributes = payload.get("object_attributes")
    attributes = attributes if isinstance(attributes, dict) else {}
    merge_request = payload.get("merge_request")
    merge_request = merge_request if isinstance(merge_request, dict) else {}
    object_kind = str(payload.get("object_kind") or event_type)
    checkout_sha = str(
        attributes.get("sha")
        or attributes.get("checkout_sha")
        or payload.get("checkout_sha")
        or ""
    )
    state = str(attributes.get("state") or attributes.get("status") or "")
    merged = state == "merged" or bool(attributes.get("merged_at"))
    check_id = attributes.get("id") if object_kind in {"pipeline", "build"} else None
    check_name = (
        str(attributes.get("name") or object_kind) if check_id is not None else None
    )
    conclusion = (
        "success"
        if state == "success"
        else "failure" if state in {"failed", "canceled"} else None
    )
    position = (
        attributes.get("position")
        if isinstance(attributes.get("position"), dict)
        else {}
    )
    author = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    note_id = attributes.get("id") if object_kind == "note" else None
    discussion_id = attributes.get("discussion_id") or note_id
    review_threads = (
        [
            {
                "id": f"gitlab-review-{discussion_id}",
                "commentId": str(note_id),
                "path": position.get("new_path") or position.get("old_path"),
                "line": position.get("new_line") or position.get("old_line"),
                "side": "right" if position.get("new_line") else "left",
                "author": author.get("username") or author.get("name"),
                "body": str(attributes.get("note") or ""),
                "url": attributes.get("url"),
                "status": (
                    "resolved"
                    if attributes.get("resolved_at") or attributes.get("resolved")
                    else "open"
                ),
                "reviewState": "changes_requested",
            }
        ]
        if note_id
        and str(attributes.get("noteable_type") or "").lower()
        in {"mergerequest", "merge_request"}
        else []
    )
    merge_request_id = (
        attributes.get("id")
        if object_kind == "merge_request"
        else merge_request.get("id")
    )
    merge_request_iid = (
        attributes.get("iid")
        if object_kind == "merge_request"
        else merge_request.get("iid")
    )
    return RepositoryProviderEventInput(
        provider_event_id=str(attributes.get("id") or delivery_id),
        delivery_id=delivery_id,
        event_type=event_type,
        branch_name=str(attributes.get("source_branch") or attributes.get("ref") or "")
        or None,
        base_branch=str(attributes.get("target_branch") or "") or None,
        head_commit=checkout_sha or None,
        pull_request_id=(
            str(merge_request_id) if merge_request_id is not None else None
        ),
        pull_request_number=(
            int(merge_request_iid) if isinstance(merge_request_iid, int) else None
        ),
        pull_request_url=str(attributes.get("url") or merge_request.get("url") or "")
        or None,
        pull_request_state=("merged" if merged else state or None),
        draft=(
            bool(attributes.get("work_in_progress"))
            if object_kind == "merge_request"
            else None
        ),
        mergeable_state=str(attributes.get("merge_status") or "") or None,
        review_decision=(
            "approved"
            if object_kind == "merge_request" and attributes.get("action") == "approved"
            else None
        ),
        ci_state=conclusion,
        merged_commit=checkout_sha if merged else None,
        checks=(
            [
                {
                    "id": str(check_id),
                    "name": check_name,
                    "status": "completed" if conclusion else state or "pending",
                    "conclusion": conclusion,
                    "detailsUrl": attributes.get("url"),
                }
            ]
            if check_id is not None
            else []
        ),
        review_threads=review_threads,
    )


@router.post("/github/webhook", response_model=RepositoryProviderEventView)
async def github_webhook(
    request: Request,
    db: Session = Depends(get_db),
    binding_id: str = Header(alias="X-Wegent-Repository-Binding"),
    timestamp: str = Header(alias="X-Wegent-Timestamp"),
    signature: str = Header(alias="X-Hub-Signature-256"),
    delivery_id: str = Header(alias="X-GitHub-Delivery"),
    event_type: str = Header(alias="X-GitHub-Event"),
) -> RepositoryProviderEventView:
    body = await request.body()
    _verify_request(
        db=db,
        provider="github",
        binding_id=binding_id,
        timestamp=timestamp,
        signature=signature,
        body=body,
    )
    return project_workflow_service.process_repository_provider_event(
        db,
        binding_id=binding_id,
        request=_github_event(
            event_type=event_type,
            delivery_id=delivery_id,
            payload=_json_body(body),
        ),
    )


@router.post("/gitlab/webhook", response_model=RepositoryProviderEventView)
async def gitlab_webhook(
    request: Request,
    db: Session = Depends(get_db),
    binding_id: str = Header(alias="X-Wegent-Repository-Binding"),
    timestamp: str = Header(alias="X-Wegent-Timestamp"),
    signature: str = Header(alias="X-Wegent-Signature"),
    delivery_id: str = Header(alias="X-Gitlab-Event-UUID"),
    event_type: str = Header(alias="X-Gitlab-Event"),
) -> RepositoryProviderEventView:
    body = await request.body()
    _verify_request(
        db=db,
        provider="gitlab",
        binding_id=binding_id,
        timestamp=timestamp,
        signature=signature,
        body=body,
    )
    return project_workflow_service.process_repository_provider_event(
        db,
        binding_id=binding_id,
        request=_gitlab_event(
            event_type=event_type,
            delivery_id=delivery_id,
            payload=_json_body(body),
        ),
    )


@router.post(
    "/workflow-automations/{webhook_token}/webhook",
    response_model=ProjectWorkflowAutomationRunView,
)
async def project_workflow_automation_webhook(
    webhook_token: str,
    request: Request,
    db: Session = Depends(get_db),
    timestamp: str = Header(alias="X-Wegent-Timestamp"),
    signature: str = Header(alias="X-Wegent-Signature"),
    delivery_id: str = Header(alias="X-Wegent-Delivery"),
) -> ProjectWorkflowAutomationRunView:
    automation = (
        db.query(ProjectWorkflowAutomation)
        .filter(ProjectWorkflowAutomation.webhook_token == webhook_token)
        .first()
    )
    if automation is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Workflow automation webhook not found",
        )
    body = await request.body()
    _verify_automation_request(
        automation=automation,
        timestamp=timestamp,
        signature=signature,
        body=body,
    )
    return project_workflow_service.trigger_webhook_automation(
        db,
        automation=automation,
        delivery_id=delivery_id,
        payload=_json_body(body),
    )
