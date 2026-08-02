# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Create idempotent Wework feedback items in the configured project."""

from __future__ import annotations

from fastapi import HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import CloudProject, LoopItem, loop_datetime_is_unset
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.schemas.feedback import FeedbackCreate, FeedbackResponse
from app.services.loop_items import loop_item_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.provider_router import loop_item_provider_router

CHANNEL_ERROR = "反馈通道异常，请联系开发者"
EXTERNAL_PROVIDERS = {"github", "gitlab"}


class FeedbackService:
    def submit(
        self,
        db: Session,
        values: FeedbackCreate,
        bundle: UploadFile,
    ) -> FeedbackResponse:
        project, user = self._configured_project_and_user(db)
        existing = self._find_existing(db, project, user.id, values.report_id)
        if existing is None:
            created = loop_item_provider_router.create(
                db,
                project,
                user,
                LoopItemCreate(
                    title=values.title,
                    description=self._description(values),
                    tags=["feedback", "wework"],
                ),
            )
            item_id = str(created.values["id"])
            internal_item = created.internal_item
            if internal_item is not None:
                internal_item.metadata_json = {
                    **internal_item.metadata_json,
                    "feedback_report_id": values.report_id,
                }
                db.commit()
        else:
            item_id, internal_item = existing

        self._ensure_bundle(
            db, project, item_id, internal_item, user.id, values.report_id, bundle
        )
        return FeedbackResponse(
            report_id=values.report_id,
            project_id=str(project.id),
            item_id=item_id,
            created_by_user_id=user.id,
            duplicate=existing is not None,
        )

    @staticmethod
    def _configured_project_and_user(db: Session) -> tuple[CloudProject, User]:
        project_id = settings.WEWORK_FEEDBACK_PROJECT_ID.strip()
        if not project_id:
            raise FeedbackService._channel_error()
        project = (
            db.query(CloudProject)
            .filter(
                CloudProject.id == project_id,
                loop_datetime_is_unset(CloudProject.deleted_at),
            )
            .first()
        )
        if project is None:
            raise FeedbackService._channel_error()
        if project.created_by_user_id is None:
            raise FeedbackService._channel_error()
        user = db.get(User, project.created_by_user_id)
        if user is None:
            raise FeedbackService._channel_error()
        return project, user

    @staticmethod
    def _ensure_bundle(
        db: Session,
        project: CloudProject,
        item_id: str,
        internal_item: LoopItem | None,
        user_id: int,
        report_id: str,
        bundle: UploadFile,
    ) -> None:
        filename = f"wework-feedback-{report_id}.zip"
        if internal_item is not None:
            if loop_item_service.has_attachment(db, internal_item.id, filename):
                return
            loop_item_service.add_feedback_attachment(
                db,
                internal_item,
                user_id,
                filename,
                bundle.content_type or "application/zip",
                bundle.file,
            )
        elif project.task_provider == "gitlab":
            external_loop_item_provider.attach_gitlab_upload(
                db,
                item_id,
                user_id,
                filename,
                bundle.content_type or "application/zip",
                bundle.file,
                settings.WEWORK_FEEDBACK_MAX_BUNDLE_SIZE_MB * 1024 * 1024,
            )
        # GitHub Issues have no generic file-upload API. The Issue is still
        # created, but its diagnostic bundle is intentionally not persisted.

    @staticmethod
    def _find_existing(
        db: Session, project: CloudProject, user_id: int, report_id: str
    ) -> tuple[str, LoopItem | None] | None:
        marker = FeedbackService._report_marker(report_id)
        if project.task_provider in EXTERNAL_PROVIDERS:
            items = external_loop_item_provider.list(db, project.id, user_id)
            return next(
                (
                    (str(item["id"]), None)
                    for item in items
                    if item.get("created_by_user_id") == user_id
                    and marker in str(item.get("description", ""))
                ),
                None,
            )

        items = (
            db.query(LoopItem)
            .filter(
                LoopItem.cloud_project_id == project.id,
                LoopItem.created_by_user_id == user_id,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .all()
        )
        item = next(
            (
                item
                for item in items
                if marker in item.description
                or (
                    isinstance(item.metadata_json, dict)
                    and item.metadata_json.get("feedback_report_id") == report_id
                )
            ),
            None,
        )
        return (item.id, item) if item is not None else None

    @staticmethod
    def _description(values: FeedbackCreate) -> str:
        sections = [
            values.description.strip(),
            FeedbackService._report_marker(values.report_id),
        ]
        return "\n\n".join(section for section in sections if section)

    @staticmethod
    def _report_marker(report_id: str) -> str:
        return f"Feedback report: {report_id}"

    @staticmethod
    def _channel_error() -> HTTPException:
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, CHANNEL_ERROR)


feedback_service = FeedbackService()
