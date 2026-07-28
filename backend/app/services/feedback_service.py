# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Create idempotent Wework feedback items in the configured project."""

from __future__ import annotations

from fastapi import HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import CloudProject, LoopItem, loop_datetime_is_unset
from app.schemas.feedback import FeedbackCreate, FeedbackResponse
from app.services.loop_items import loop_item_service

CHANNEL_ERROR = "反馈通道异常，请联系开发者"


class FeedbackService:
    def submit(
        self,
        db: Session,
        user_id: int,
        values: FeedbackCreate,
        bundle: UploadFile,
    ) -> FeedbackResponse:
        project_id = settings.WEWORK_FEEDBACK_PROJECT_ID.strip()
        if not project_id:
            raise self._channel_error()

        project = (
            db.query(CloudProject)
            .filter(
                CloudProject.id == project_id,
                loop_datetime_is_unset(CloudProject.deleted_at),
            )
            .with_for_update()
            .first()
        )
        if project is None or project.task_provider != "local":
            raise self._channel_error()

        existing = self._find_existing(db, project.id, user_id, values.report_id)
        if existing is not None:
            db.commit()
            self._ensure_bundle(db, existing, user_id, values.report_id, bundle)
            return self._response(existing, values.report_id, user_id, duplicate=True)

        sequence = project.next_item_number
        project.next_item_number += 1
        item = LoopItem(
            id=f"{project.project_key}-{sequence}",
            cloud_project_id=project.id,
            sequence_number=sequence,
            created_by_user_id=user_id,
            title=values.title,
            description=self._description(values),
            status="inbox",
            priority="none",
            metadata_json={
                "tags": ["feedback", "wework"],
                "feedback_report_id": values.report_id,
            },
        )
        db.add(item)
        db.commit()
        db.refresh(item)
        self._ensure_bundle(db, item, user_id, values.report_id, bundle)
        return self._response(item, values.report_id, user_id, duplicate=False)

    @staticmethod
    def _ensure_bundle(
        db: Session,
        item: LoopItem,
        user_id: int,
        report_id: str,
        bundle: UploadFile,
    ) -> None:
        filename = f"wework-feedback-{report_id}.zip"
        if loop_item_service.has_attachment(db, item.id, filename):
            return
        loop_item_service.add_feedback_attachment(
            db,
            item,
            user_id,
            filename,
            bundle.content_type or "application/zip",
            bundle.file,
        )

    @staticmethod
    def _find_existing(
        db: Session, project_id: str, user_id: int, report_id: str
    ) -> LoopItem | None:
        items = (
            db.query(LoopItem)
            .filter(
                LoopItem.cloud_project_id == project_id,
                LoopItem.created_by_user_id == user_id,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .all()
        )
        return next(
            (
                item
                for item in items
                if isinstance(item.metadata_json, dict)
                and item.metadata_json.get("feedback_report_id") == report_id
            ),
            None,
        )

    @staticmethod
    def _description(values: FeedbackCreate) -> str:
        # Diagnostic context belongs in the attached bundle. Keeping it out of
        # the board item avoids duplicating private data and overflowing the
        # database text column.
        sections = [values.description.strip(), f"Feedback report: {values.report_id}"]
        return "\n\n".join(section for section in sections if section)

    @staticmethod
    def _response(
        item: LoopItem, report_id: str, user_id: int, *, duplicate: bool
    ) -> FeedbackResponse:
        return FeedbackResponse(
            report_id=report_id,
            project_id=str(item.cloud_project_id),
            item_id=item.id,
            created_by_user_id=user_id,
            duplicate=duplicate,
        )

    @staticmethod
    def _channel_error() -> HTTPException:
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, CHANNEL_ERROR)


feedback_service = FeedbackService()
