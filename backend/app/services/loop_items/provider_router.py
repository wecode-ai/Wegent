# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Route loop-item creation through the configured project provider."""

from dataclasses import dataclass
from typing import BinaryIO

from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service


@dataclass(frozen=True)
class RoutedLoopItem:
    values: dict[str, object]
    internal_item: LoopItem | None


class LoopItemProviderRouter:
    def create(
        self,
        db: Session,
        project: CloudProject,
        user: User,
        values: LoopItemCreate,
    ) -> RoutedLoopItem:
        if project.task_provider in {"github", "gitlab"}:
            created = external_loop_item_provider.create(
                db, project.id, user.id, user.user_name, values
            )
            return RoutedLoopItem(values=created, internal_item=None)

        item = loop_item_service.create(db, project.id, user.id, values)
        response = loop_item_service.response_values(db, item, user.id)
        return RoutedLoopItem(values=response, internal_item=item)


loop_item_provider_router = LoopItemProviderRouter()


class LoopItemAttachmentProviderRouter:
    def list(self, db: Session, item_id: str, user_id: int) -> list[object]:
        if external_loop_item_provider.is_external_item(db, item_id):
            return external_loop_item_provider.list_attachments(db, item_id, user_id)
        return loop_item_service.list_attachments(db, item_id, user_id)

    def add(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        filename: str,
        content_type: str,
        source: BinaryIO,
        max_size_bytes: int,
    ) -> object:
        if external_loop_item_provider.is_external_item(db, item_id):
            return external_loop_item_provider.add_attachment(
                db,
                item_id,
                user_id,
                filename,
                content_type,
                source,
                max_size_bytes,
            )
        return loop_item_service.add_attachment(
            db, item_id, user_id, filename, content_type, source
        )

    def content(
        self, db: Session, attachment_id: str, user_id: int
    ) -> tuple[bytes, str, str]:
        if attachment_id.startswith("gitlab-"):
            return external_loop_item_provider.attachment_content(
                db, attachment_id, user_id
            )
        return loop_item_service.attachment_content(db, attachment_id, user_id)

    def delete(self, db: Session, attachment_id: str, user_id: int) -> None:
        if attachment_id.startswith("gitlab-"):
            external_loop_item_provider.delete_attachment(db, attachment_id, user_id)
            return
        loop_item_service.delete_attachment(db, attachment_id, user_id)

    def require_access(self, db: Session, attachment_id: str, user_id: int) -> None:
        if attachment_id.startswith("gitlab-"):
            external_loop_item_provider.attachment_access_url(
                db, attachment_id, user_id
            )
            return
        loop_item_service.require_attachment_access(db, attachment_id, user_id)


loop_item_attachment_provider_router = LoopItemAttachmentProviderRouter()
