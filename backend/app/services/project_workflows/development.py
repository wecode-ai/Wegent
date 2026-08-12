# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Pull request, CI, review, merge, and provider-event workflow actions."""

import hashlib
import json
import uuid

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.project_workflow import (
    EPOCH_TIME,
    ProjectRepositoryBinding,
    RepositoryProviderEvent,
    TaskDevelopmentCheck,
    TaskDevelopmentLink,
    TaskDevelopmentReviewThread,
    TaskStageRun,
    TaskWorkflowRun,
)
from app.schemas.base_role import BaseRole
from app.schemas.project_workflow import (
    PullRequestCreate,
    PullRequestMerge,
    RepositoryProviderEventInput,
    RepositoryProviderEventView,
    TaskDevelopmentView,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_item_executions.service import utcnow
from app.services.project_workflows.provider import (
    PullRequestState,
    repository_provider_client,
)
from app.services.project_workflows.state import (
    StageStatus,
    WorkflowStatus,
)


def _id() -> str:
    return uuid.uuid4().hex


def _row_version(row: object, expected: int) -> None:
    if int(getattr(row, "version", 0)) != expected:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Resource was modified; reload it before saving",
        )


class DevelopmentWorkflowMixin:
    """Manage repository-provider state attached to workflow runs."""

    def get_task_development(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
    ) -> list[TaskDevelopmentView]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        self._require_task(db, project_id, item_id)
        rows = (
            db.query(TaskDevelopmentLink)
            .filter(TaskDevelopmentLink.loop_item_id == item_id)
            .order_by(TaskDevelopmentLink.created_at.asc())
            .all()
        )
        return [self._development_view(db, row) for row in rows]

    def create_pull_request(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        development_id: str,
        user_id: int,
        request: PullRequestCreate,
    ) -> TaskDevelopmentView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        task = self._require_task(db, project_id, item_id)
        link, repository = self._development_action_rows(
            db,
            item_id=item_id,
            development_id=development_id,
        )
        if link.pull_request_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Task development already has a pull request",
            )
        state = repository_provider_client.create_pull_request(
            db,
            repository=repository,
            user_id=user_id,
            branch_name=link.branch_name,
            base_branch=link.base_branch or repository.default_branch,
            title=request.title or task.title,
            body=request.body,
            draft=request.draft,
        )
        self._apply_pull_request_state(link, state)
        self._apply_provider_snapshot(db, link=link, state=state)
        link.version += 1
        db.commit()
        db.refresh(link)
        return self._development_view(db, link)

    def refresh_pull_request(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        development_id: str,
        user_id: int,
    ) -> TaskDevelopmentView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        self._require_task(db, project_id, item_id)
        link, repository = self._development_action_rows(
            db,
            item_id=item_id,
            development_id=development_id,
        )
        if not link.pull_request_number:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Task development has no pull request",
            )
        state = repository_provider_client.refresh_pull_request(
            db,
            repository=repository,
            user_id=user_id,
            number=link.pull_request_number,
        )
        self._apply_pull_request_state(link, state)
        self._apply_provider_snapshot(db, link=link, state=state)
        link.version += 1
        self._reevaluate_task_platform_stages(
            db,
            item_id=item_id,
            user_id=user_id,
        )
        db.commit()
        db.refresh(link)
        return self._development_view(db, link)

    def merge_pull_request(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        development_id: str,
        user_id: int,
        request: PullRequestMerge,
    ) -> TaskDevelopmentView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        self._require_task(db, project_id, item_id)
        link, repository = self._development_action_rows(
            db,
            item_id=item_id,
            development_id=development_id,
        )
        _row_version(link, request.version)
        if not link.pull_request_number:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Task development has no pull request",
            )
        settings = repository.provider_settings_json or {}
        if settings.get("requireCi", True) and link.ci_state != "success":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Pull request cannot merge before CI succeeds",
            )
        if settings.get("requireReview", True) and link.review_decision != "approved":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Pull request cannot merge before review approval",
            )
        state = repository_provider_client.merge_pull_request(
            db,
            repository=repository,
            user_id=user_id,
            number=link.pull_request_number,
            method=request.method,
        )
        self._apply_pull_request_state(link, state)
        self._apply_provider_snapshot(db, link=link, state=state)
        link.version += 1
        self._reevaluate_task_platform_stages(
            db,
            item_id=item_id,
            user_id=user_id,
        )
        db.commit()
        db.refresh(link)
        return self._development_view(db, link)

    @staticmethod
    def _development_action_rows(
        db: Session,
        *,
        item_id: str,
        development_id: str,
    ) -> tuple[TaskDevelopmentLink, ProjectRepositoryBinding]:
        link = (
            db.query(TaskDevelopmentLink)
            .filter(
                TaskDevelopmentLink.id == development_id,
                TaskDevelopmentLink.loop_item_id == item_id,
            )
            .first()
        )
        if link is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Task development not found")
        repository = db.get(ProjectRepositoryBinding, link.repository_binding_id)
        if repository is None or repository.status != "active":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Task repository binding is no longer active",
            )
        return link, repository

    @staticmethod
    def _apply_pull_request_state(
        link: TaskDevelopmentLink,
        state: PullRequestState,
    ) -> None:
        link.pull_request_id = state.provider_id
        link.pull_request_number = state.number
        link.pull_request_url = state.url
        link.pull_request_state = state.state
        link.draft = int(state.draft)
        link.mergeable_state = state.mergeable_state or ""
        if state.review_decision:
            link.review_decision = state.review_decision
        if state.head_commit:
            link.head_commit = state.head_commit
        if state.merged_commit:
            link.merged_commit = state.merged_commit

    @staticmethod
    def _apply_provider_snapshot(
        db: Session,
        *,
        link: TaskDevelopmentLink,
        state: PullRequestState,
    ) -> None:
        for check in state.checks:
            row = (
                db.query(TaskDevelopmentCheck)
                .filter(
                    TaskDevelopmentCheck.development_link_id == link.id,
                    TaskDevelopmentCheck.provider_check_id == check.provider_id,
                )
                .first()
            )
            if row is None:
                row = TaskDevelopmentCheck(
                    id=_id(),
                    development_link_id=link.id,
                    provider_check_id=check.provider_id,
                )
                db.add(row)
            row.name = check.name
            row.status = check.status
            row.conclusion = check.conclusion or ""
            row.details_url = check.details_url or ""
            row.started_at = check.started_at or EPOCH_TIME
            row.completed_at = check.completed_at or EPOCH_TIME
        if state.checks:
            conclusions = {
                check.conclusion for check in state.checks if check.conclusion
            }
            statuses = {check.status for check in state.checks}
            if conclusions & {"failure", "failed", "cancelled", "timed_out"}:
                link.ci_state = "failure"
            elif statuses <= {"completed"} and conclusions <= {
                "success",
                "skipped",
                "neutral",
            }:
                link.ci_state = "success"
            else:
                link.ci_state = "pending"
        provider_thread_ids = {thread.provider_id for thread in state.review_threads}
        for thread in state.review_threads:
            row = (
                db.query(TaskDevelopmentReviewThread)
                .filter(
                    TaskDevelopmentReviewThread.development_link_id == link.id,
                    TaskDevelopmentReviewThread.provider_thread_id
                    == thread.provider_id,
                )
                .first()
            )
            if row is None:
                row = TaskDevelopmentReviewThread(
                    id=_id(),
                    development_link_id=link.id,
                    provider_thread_id=thread.provider_id,
                )
                db.add(row)
            row.provider_comment_id = thread.comment_id or ""
            row.path = thread.path or ""
            row.line = thread.line or 0
            row.side = thread.side or ""
            row.author = thread.author or ""
            row.body = thread.body
            row.url = thread.url or ""
            row.status = thread.status
            row.review_state = thread.review_state or ""
        if provider_thread_ids:
            stale_rows = (
                db.query(TaskDevelopmentReviewThread)
                .filter(
                    TaskDevelopmentReviewThread.development_link_id == link.id,
                    TaskDevelopmentReviewThread.provider_thread_id.notin_(
                        provider_thread_ids
                    ),
                    TaskDevelopmentReviewThread.status == "open",
                )
                .all()
            )
            for row in stale_rows:
                row.status = "outdated"

    def process_repository_provider_event(
        self,
        db: Session,
        *,
        binding_id: str,
        request: RepositoryProviderEventInput,
        project_id: int | None = None,
        user_id: int | None = None,
    ) -> RepositoryProviderEventView:
        repository = db.get(ProjectRepositoryBinding, binding_id)
        if repository is None or repository.status != "active":
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Repository binding not found"
            )
        if project_id is not None and repository.cloud_project_id != str(project_id):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Repository binding not found"
            )
        if user_id is not None:
            require_cloud_project_role(
                db,
                int(repository.cloud_project_id),
                user_id,
                BaseRole.Maintainer,
            )
        existing = (
            db.query(RepositoryProviderEvent)
            .filter(
                RepositoryProviderEvent.repository_binding_id == repository.id,
                RepositoryProviderEvent.delivery_id == request.delivery_id,
            )
            .first()
        )
        if existing:
            view = self._provider_event_view(existing)
            return view.model_copy(update={"duplicate": True})
        payload_sha = hashlib.sha256(
            json.dumps(
                request.model_dump(mode="json"),
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        event = RepositoryProviderEvent(
            repository_binding_id=repository.id,
            provider_event_id=request.provider_event_id,
            event_type=request.event_type,
            delivery_id=request.delivery_id,
            payload_sha256=payload_sha,
            processing_status="pending",
        )
        db.add(event)
        db.flush()
        link = self._match_development_link(
            db,
            repository_id=repository.id,
            request=request,
        )
        if link is None:
            event.processing_status = "unmatched"
            event.processed_at = utcnow()
            db.commit()
            db.refresh(event)
            return self._provider_event_view(event)
        occurred_at = request.occurred_at or utcnow()
        if (
            link.last_provider_event_at > EPOCH_TIME
            and occurred_at < link.last_provider_event_at
        ):
            event.processing_status = "ignored_out_of_order"
            event.processed_at = utcnow()
            db.commit()
            db.refresh(event)
            return self._provider_event_view(event)
        self._apply_provider_event(db, link=link, request=request)
        link.last_provider_event_at = occurred_at
        link.version += 1
        event.processing_status = "processed"
        event.processed_at = utcnow()
        self._reevaluate_task_platform_stages(
            db,
            item_id=link.loop_item_id,
            user_id=user_id or 0,
        )
        db.commit()
        db.refresh(event)
        return self._provider_event_view(event)

    @staticmethod
    def _match_development_link(
        db: Session,
        *,
        repository_id: str,
        request: RepositoryProviderEventInput,
    ) -> TaskDevelopmentLink | None:
        query = db.query(TaskDevelopmentLink).filter(
            TaskDevelopmentLink.repository_binding_id == repository_id
        )
        if request.pull_request_id:
            matched = query.filter(
                TaskDevelopmentLink.pull_request_id == request.pull_request_id
            ).first()
            if matched:
                return matched
        if request.branch_name:
            return query.filter(
                TaskDevelopmentLink.branch_name == request.branch_name
            ).first()
        return None

    def _apply_provider_event(
        self,
        db: Session,
        *,
        link: TaskDevelopmentLink,
        request: RepositoryProviderEventInput,
    ) -> None:
        mappings = {
            "branch_name": "branch_name",
            "base_branch": "base_branch",
            "head_commit": "head_commit",
            "pull_request_id": "pull_request_id",
            "pull_request_number": "pull_request_number",
            "pull_request_url": "pull_request_url",
            "pull_request_state": "pull_request_state",
            "draft": "draft",
            "mergeable_state": "mergeable_state",
            "review_decision": "review_decision",
            "ci_state": "ci_state",
            "merged_commit": "merged_commit",
        }
        values = request.model_dump(exclude_unset=True)
        for key, attribute in mappings.items():
            if key not in values or values[key] is None:
                continue
            value = values[key]
            if key == "draft":
                value = int(bool(value))
            setattr(link, attribute, value)
        for check in request.checks:
            row = (
                db.query(TaskDevelopmentCheck)
                .filter(
                    TaskDevelopmentCheck.development_link_id == link.id,
                    TaskDevelopmentCheck.provider_check_id == check.id,
                )
                .first()
            )
            if row is None:
                row = TaskDevelopmentCheck(
                    id=_id(),
                    development_link_id=link.id,
                    provider_check_id=check.id,
                )
                db.add(row)
            row.name = check.name
            row.status = check.status
            row.conclusion = check.conclusion or ""
            row.details_url = check.details_url or ""
            row.started_at = check.started_at or EPOCH_TIME
            row.completed_at = check.completed_at or EPOCH_TIME
        for thread in request.review_threads:
            row = (
                db.query(TaskDevelopmentReviewThread)
                .filter(
                    TaskDevelopmentReviewThread.development_link_id == link.id,
                    TaskDevelopmentReviewThread.provider_thread_id == thread.id,
                )
                .first()
            )
            if row is None:
                row = TaskDevelopmentReviewThread(
                    id=_id(),
                    development_link_id=link.id,
                    provider_thread_id=thread.id,
                )
                db.add(row)
            row.provider_comment_id = thread.comment_id or ""
            row.path = thread.path or ""
            row.line = thread.line or 0
            row.side = thread.side or ""
            row.author = thread.author or ""
            row.body = thread.body
            row.url = thread.url or ""
            row.status = thread.status
            row.review_state = thread.review_state or ""
        if request.checks and "ci_state" not in values:
            conclusions = {
                check.conclusion
                for check in request.checks
                if check.conclusion is not None
            }
            statuses = {check.status for check in request.checks}
            if conclusions & {"failure", "failed", "cancelled", "timed_out"}:
                link.ci_state = "failure"
            elif (
                statuses
                and statuses <= {"completed"}
                and conclusions
                <= {
                    "success",
                    "skipped",
                    "neutral",
                }
            ):
                link.ci_state = "success"
            else:
                link.ci_state = "pending"
        if (
            request.review_threads
            and "review_decision" not in values
            and any(
                thread.status == "open" and thread.review_state == "changes_requested"
                for thread in request.review_threads
            )
        ):
            link.review_decision = "changes_requested"

    def _reevaluate_task_platform_stages(
        self,
        db: Session,
        *,
        item_id: str,
        user_id: int,
    ) -> None:
        task = db.get(LoopItem, item_id)
        if task is None:
            return
        runs = (
            db.query(TaskWorkflowRun)
            .filter(
                TaskWorkflowRun.loop_item_id == item_id,
                TaskWorkflowRun.status.in_(
                    [
                        WorkflowStatus.QUEUED.value,
                        WorkflowStatus.RUNNING.value,
                        WorkflowStatus.BLOCKED.value,
                    ]
                ),
            )
            .all()
        )
        for run in runs:
            stages = (
                db.query(TaskStageRun)
                .filter(
                    TaskStageRun.workflow_run_id == run.id,
                    TaskStageRun.status == StageStatus.QUEUED.value,
                    TaskStageRun.node_type.in_(["ci_gate", "merge", "complete"]),
                )
                .all()
            )
            for stage in stages:
                self._evaluate_platform_stage(
                    db,
                    run=run,
                    stage=stage,
                    task=task,
                    user_id=user_id or int(run.started_by_id or 0),
                )
