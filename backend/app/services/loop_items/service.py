# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cloud TODO lifecycle and runtime Task associations."""

from __future__ import annotations

import hashlib
import tempfile
import uuid
from datetime import datetime, timezone
from typing import BinaryIO

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.cloud_project import (
    CloudProject,
    LoopItemTaskBinding,
)
from app.models.delivery import (
    LoopItem,
    LoopItemAttachment,
    LoopItemCollaborator,
    adapt_loop_node_values_for_dialect,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.delivery import (
    LoopItemCreate,
    LoopItemReorder,
    LoopItemTaskBind,
    LoopItemUpdate,
)
from app.services.cloud_projects.access import (
    CloudProjectAccess,
    require_cloud_project_role,
)
from app.services.delivery.storage import delivery_storage
from app.stores.tasks import task_store


class LoopItemService:
    def _require_internal_task_project(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        required_role: BaseRole = BaseRole.Reporter,
        *,
        allow_public_visitor: bool = False,
    ) -> CloudProjectAccess:
        access = require_cloud_project_role(
            db, cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        if access.is_public_visitor:
            if not allow_public_visitor:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN, "Insufficient permission"
                )
        elif not has_permission(access.role, required_role):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        project = access.project
        if project.task_provider != "local":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                (
                    f"Project tasks are provided by {project.task_provider}; "
                    "use the local Issue provider"
                ),
            )
        return access

    @staticmethod
    def _item_permissions(
        access: CloudProjectAccess, item: LoopItem, user_id: int
    ) -> tuple[bool, bool]:
        if access.is_public_visitor:
            owns_item = item.created_by_user_id == user_id
            return owns_item, owns_item
        return True, has_permission(access.role, BaseRole.Developer)

    def response_values(
        self,
        db: Session,
        item: LoopItem,
        user_id: int,
        access: CloudProjectAccess | None = None,
    ) -> dict[str, object]:
        access = access or require_cloud_project_role(
            db, item.cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        can_view_detail, can_edit = self._item_permissions(access, item, user_id)
        values = {
            **item.__dict__,
            "can_view_detail": can_view_detail,
            "can_edit": can_edit,
        }
        if not can_view_detail:
            values["description"] = ""
        return values

    def _get_item_row(
        self, db: Session, item_id: str, *, include_deleted: bool = False
    ) -> LoopItem:
        query = db.query(LoopItem).filter(LoopItem.id == item_id)
        if not include_deleted:
            query = query.filter(loop_datetime_is_unset(LoopItem.deleted_at))
        item = query.first()
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return item

    def _require_item_access(
        self,
        db: Session,
        item: LoopItem,
        user_id: int,
        *,
        edit: bool = False,
    ) -> CloudProjectAccess:
        access = require_cloud_project_role(
            db, item.cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        can_view_detail, can_edit = self._item_permissions(access, item, user_id)
        if edit and not can_edit:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        if not edit and not can_view_detail:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
        return access

    def ensure_collaborator(
        self,
        db: Session,
        item: LoopItem,
        collaborator_user_id: int,
        added_by_user_id: int,
        source: str,
        *,
        commit: bool = True,
    ) -> LoopItemCollaborator:
        """Ensure one project member participates in a TODO."""

        require_cloud_project_role(
            db,
            item.cloud_project_id,
            collaborator_user_id,
            BaseRole.RestrictedAnalyst,
        )
        collaborator = (
            db.query(LoopItemCollaborator)
            .filter(
                LoopItemCollaborator.loop_item_id == item.id,
                LoopItemCollaborator.user_id == collaborator_user_id,
            )
            .first()
        )
        if collaborator is None:
            collaborator = LoopItemCollaborator(
                loop_item_id=item.id,
                user_id=collaborator_user_id,
                source=source,
                added_by_user_id=added_by_user_id,
            )
            db.add(collaborator)
            if commit:
                db.commit()
                db.refresh(collaborator)
        return collaborator

    def list_collaborators(
        self, db: Session, item_id: str, user_id: int
    ) -> list[dict[str, object]]:
        self.get(db, item_id, user_id)
        rows = (
            db.query(LoopItemCollaborator, User)
            .join(User, User.id == LoopItemCollaborator.user_id)
            .filter(LoopItemCollaborator.loop_item_id == item_id)
            .order_by(LoopItemCollaborator.created_at, LoopItemCollaborator.id)
            .all()
        )
        return [
            {
                **collaborator.__dict__,
                "user_name": collaborator_user.user_name,
                "email": collaborator_user.email,
            }
            for collaborator, collaborator_user in rows
        ]

    def add_collaborator(
        self, db: Session, item_id: str, collaborator_user_id: int, user_id: int
    ) -> dict[str, object]:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        self.ensure_collaborator(db, item, collaborator_user_id, user_id, "manual")
        return next(
            row
            for row in self.list_collaborators(db, item_id, user_id)
            if row["user_id"] == collaborator_user_id
        )

    def remove_collaborator(
        self, db: Session, item_id: str, collaborator_user_id: int, user_id: int
    ) -> None:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        collaborator = (
            db.query(LoopItemCollaborator)
            .filter(
                LoopItemCollaborator.loop_item_id == item_id,
                LoopItemCollaborator.user_id == collaborator_user_id,
            )
            .first()
        )
        if collaborator is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Collaborator not found")
        db.delete(collaborator)
        db.commit()

    def create(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        values: LoopItemCreate,
    ) -> LoopItem:
        self._require_internal_task_project(
            db,
            cloud_project_id,
            user_id,
            BaseRole.Developer,
            allow_public_visitor=True,
        )
        if values.parent_id is not None:
            self._require_parent(db, values.parent_id, cloud_project_id)
        project = (
            db.query(CloudProject)
            .filter(CloudProject.id == cloud_project_id)
            .with_for_update()
            .one()
        )
        sequence = project.next_item_number
        project.next_item_number += 1
        payload = values.model_dump()
        tags = payload.pop("tags")
        item = LoopItem(
            id=f"{project.project_key}-{sequence}",
            cloud_project_id=project.id,
            sequence_number=sequence,
            created_by_user_id=user_id,
            **payload,
        )
        if tags:
            item.metadata_json = {"tags": tags}
        if item.status == "completed":
            item.completed_at = self._now()
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    def list(self, db: Session, cloud_project_id: int, user_id: int) -> list[LoopItem]:
        self._require_internal_task_project(
            db, cloud_project_id, user_id, allow_public_visitor=True
        )
        return (
            db.query(LoopItem)
            .filter(
                LoopItem.cloud_project_id == cloud_project_id,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .order_by(LoopItem.sort_order, LoopItem.updated_at.desc())
            .all()
        )

    def reorder(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        values: LoopItemReorder,
    ) -> list[LoopItem]:
        """Persist the manual order of the TODOs in one board lane."""

        self._require_internal_task_project(
            db, cloud_project_id, user_id, BaseRole.Developer
        )
        if values.parent_id is None:
            # MySQL stores unset parent ids as empty strings, so match both.
            parent_filter = or_(LoopItem.parent_id.is_(None), LoopItem.parent_id == "")
        else:
            parent_filter = LoopItem.parent_id == values.parent_id
        lane = (
            db.query(LoopItem)
            .filter(
                LoopItem.cloud_project_id == cloud_project_id,
                LoopItem.status == values.status,
                parent_filter,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .order_by(LoopItem.sort_order, LoopItem.updated_at.desc())
            .all()
        )
        by_id = {item.id: item for item in lane}
        requested_ids = [item_id for item_id in values.item_ids if item_id in by_id]
        if not requested_ids:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "TODO not found in lane"
            )
        # Lane members missing from the request (e.g. created concurrently)
        # keep their relative order at the end of the lane.
        ordered = [by_id[item_id] for item_id in requested_ids] + [
            item for item in lane if item.id not in requested_ids
        ]
        for position, item in enumerate(ordered):
            if item.sort_order != position:
                item.sort_order = position
                item.version += 1
        db.commit()
        for item in ordered:
            db.refresh(item)
        return ordered

    def get(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        item = self._get_item_row(db, item_id)
        self._require_item_access(db, item, user_id)
        return item

    def list_attachments(
        self, db: Session, item_id: str, user_id: int
    ) -> list[LoopItemAttachment]:
        self.get(db, item_id, user_id)
        return (
            db.query(LoopItemAttachment)
            .filter(LoopItemAttachment.loop_item_id == item_id)
            .order_by(LoopItemAttachment.created_at.desc())
            .all()
        )

    def add_attachment(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        display_name: str,
        content_type: str,
        source: BinaryIO,
    ) -> LoopItemAttachment:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        project = db.get(CloudProject, item.cloud_project_id)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")

        return self._store_attachment(
            db,
            item,
            project,
            user_id,
            display_name,
            content_type,
            source,
            settings.DELIVERY_MAX_ASSET_SIZE_MB,
        )

    def has_attachment(self, db: Session, item_id: str, display_name: str) -> bool:
        return (
            db.query(LoopItemAttachment)
            .filter(
                LoopItemAttachment.loop_item_id == item_id,
                LoopItemAttachment.display_name == display_name,
            )
            .first()
            is not None
        )

    def add_feedback_attachment(
        self,
        db: Session,
        item: LoopItem,
        user_id: int,
        display_name: str,
        content_type: str,
        source: BinaryIO,
    ) -> LoopItemAttachment:
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        if item.created_by_user_id != user_id or not metadata.get("feedback_report_id"):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Invalid feedback attachment"
            )
        project = db.get(CloudProject, item.cloud_project_id)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
        return self._store_attachment(
            db,
            item,
            project,
            user_id,
            display_name,
            content_type,
            source,
            settings.WEWORK_FEEDBACK_MAX_BUNDLE_SIZE_MB,
        )

    @staticmethod
    def _store_attachment(
        db: Session,
        item: LoopItem,
        project: CloudProject,
        user_id: int,
        display_name: str,
        content_type: str,
        source: BinaryIO,
        max_size_mb: int,
    ) -> LoopItemAttachment:

        attachment_id = str(uuid.uuid4())
        object_key = (
            f"projects/{project.public_id}/loop-items/{item.id}/attachments/"
            f"{attachment_id}"
        )
        digest = hashlib.sha256()
        length = 0
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as staged:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                staged.write(chunk)
                length += len(chunk)
                if length > max_size_mb * 1024 * 1024:
                    raise HTTPException(
                        status.HTTP_413_CONTENT_TOO_LARGE,
                        "TODO attachment is too large",
                    )
            staged.seek(0)
            delivery_storage.put_stream(object_key, staged, length, content_type)

        attachment = LoopItemAttachment(
            id=attachment_id,
            loop_item_id=item.id,
            display_name=display_name[:255],
            object_key=object_key,
            content_type=content_type,
            size_bytes=length,
            sha256=digest.hexdigest(),
            created_by_user_id=user_id,
        )
        try:
            db.add(attachment)
            db.commit()
            db.refresh(attachment)
            return attachment
        except Exception:
            db.rollback()
            delivery_storage.remove_objects([object_key])
            raise

    def attachment_access_url(
        self, db: Session, attachment_id: str, user_id: int
    ) -> str:
        attachment = self._get_attachment(db, attachment_id, user_id)
        return delivery_storage.download_url(attachment.object_key)

    def attachment_content(
        self, db: Session, attachment_id: str, user_id: int
    ) -> tuple[bytes, str, str]:
        attachment = self._get_attachment(db, attachment_id, user_id)
        return (
            delivery_storage.get_bytes(attachment.object_key),
            attachment.content_type or "application/octet-stream",
            attachment.display_name,
        )

    def require_attachment_access(
        self, db: Session, attachment_id: str, user_id: int
    ) -> None:
        self._get_attachment(db, attachment_id, user_id)

    def delete_attachment(self, db: Session, attachment_id: str, user_id: int) -> None:
        attachment = self._get_attachment(db, attachment_id, user_id)
        item = self.get(db, attachment.loop_item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        delivery_storage.remove_objects([attachment.object_key])
        db.delete(attachment)
        db.commit()

    def _get_attachment(
        self, db: Session, attachment_id: str, user_id: int
    ) -> LoopItemAttachment:
        attachment = db.get(LoopItemAttachment, attachment_id)
        if attachment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO attachment not found")
        self.get(db, attachment.loop_item_id, user_id)
        return attachment

    def update(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        values: LoopItemUpdate,
    ) -> LoopItem:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        updates = values.model_dump(exclude={"version"}, exclude_unset=True)
        if "parent_id" in values.model_fields_set:
            self._validate_parent_change(db, item, values.parent_id)
        if "tags" in values.model_fields_set:
            # Tags live inside the metadata JSON column; merge so other
            # metadata keys survive the update.
            metadata = dict(item.metadata_json or {})
            metadata["tags"] = updates.pop("tags") or []
            updates["metadata_json"] = metadata
        next_status = updates.get("status")
        if next_status and next_status != item.status:
            updates["completed_at"] = (
                self._now() if next_status == "completed" else None
            )
            # Reset the manual lane position so the TODO lands at the top of
            # its new lane instead of an arbitrary stale position.
            updates["sort_order"] = 0
        updates = adapt_loop_node_values_for_dialect(
            updates, db.get_bind().dialect.name
        )
        updated = (
            db.query(LoopItem)
            .filter(LoopItem.id == item.id, LoopItem.version == values.version)
            .update({**updates, "version": LoopItem.version + 1})
        )
        if updated != 1:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "TODO changed")
        db.commit()
        db.refresh(item)
        return item

    def delete(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        """Soft delete a TODO; the row is kept for the recycle bin."""

        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        item.deleted_at = self._now()
        item.version += 1
        db.commit()
        db.refresh(item)
        return item

    def restore(self, db: Session, item_id: str, user_id: int) -> LoopItem:
        """Restore a soft-deleted TODO from the recycle bin."""

        item = self._get_item_row(db, item_id, include_deleted=True)
        self._require_item_access(db, item, user_id, edit=True)
        if loop_datetime_value_is_unset(item.deleted_at):
            raise HTTPException(status.HTTP_409_CONFLICT, "TODO is not deleted")
        item.deleted_at = None
        item.version += 1
        db.commit()
        db.refresh(item)
        return item

    def list_deleted(
        self, db: Session, cloud_project_id: int, user_id: int
    ) -> list[LoopItem]:
        """List soft-deleted TODOs of a project, most recently deleted first."""

        access = require_cloud_project_role(
            db, cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        query = db.query(LoopItem).filter(
            LoopItem.cloud_project_id == cloud_project_id,
            ~loop_datetime_is_unset(LoopItem.deleted_at),
        )
        if access.is_public_visitor:
            query = query.filter(LoopItem.created_by_user_id == user_id)
        return query.order_by(LoopItem.deleted_at.desc()).all()

    def _require_parent(
        self, db: Session, parent_id: str, cloud_project_id: int
    ) -> LoopItem:
        parent = db.get(LoopItem, parent_id)
        if parent is None or not loop_datetime_value_is_unset(parent.deleted_at):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Parent TODO not found"
            )
        if str(parent.cloud_project_id) != str(cloud_project_id):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Parent TODO must belong to the same project",
            )
        return parent

    def _validate_parent_change(
        self, db: Session, item: LoopItem, parent_id: str | None
    ) -> None:
        if parent_id is None:
            return
        if parent_id == item.id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "TODO cannot be its own parent"
            )
        parent = self._require_parent(db, parent_id, item.cloud_project_id)
        visited = {item.id}
        while parent is not None:
            if parent.id in visited:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "TODO hierarchy cannot contain a cycle",
                )
            visited.add(parent.id)
            parent = db.get(LoopItem, parent.parent_id) if parent.parent_id else None

    def bind_task(
        self,
        db: Session,
        item_id: str,
        values: LoopItemTaskBind,
        user_id: int,
    ) -> LoopItemTaskBinding:
        item = self.get(db, item_id, user_id)
        self._require_item_access(db, item, user_id, edit=True)
        self._validate_backend_task(db, values.backend_task_id, user_id)
        active = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.task_user_id == user_id,
                LoopItemTaskBinding.device_id == values.device_id,
                LoopItemTaskBinding.task_id == values.task_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .with_for_update()
            .first()
        )
        if active is not None:
            if active.loop_item_id == item_id:
                if values.task_title and active.task_title != values.task_title:
                    active.task_title = values.task_title
                self.ensure_collaborator(
                    db, item, user_id, user_id, "task", commit=False
                )
                self._advance_task_started_item(db, item.id)
                db.commit()
                db.refresh(active)
                return active
            active.unlinked_at = self._now()
        binding = LoopItemTaskBinding(
            cloud_project_id=item.cloud_project_id,
            loop_item_id=item_id,
            task_user_id=user_id,
            device_id=values.device_id,
            task_id=values.task_id,
            task_title=values.task_title,
            backend_task_id=values.backend_task_id,
            linked_by_user_id=user_id,
        )
        db.add(binding)
        self.ensure_collaborator(db, item, user_id, user_id, "task", commit=False)
        self._advance_task_started_item(db, item.id)
        db.commit()
        db.refresh(binding)
        return binding

    def bind_project_task(
        self,
        db: Session,
        cloud_project_id: int,
        values: LoopItemTaskBind,
        user_id: int,
    ) -> LoopItemTaskBinding:
        """Associate a runtime Task with a cloud project without choosing a TODO."""

        require_cloud_project_role(
            db, cloud_project_id, user_id, BaseRole.RestrictedAnalyst
        )
        self._validate_backend_task(db, values.backend_task_id, user_id)
        active = self._active_task_binding(db, values, user_id, lock=True)
        if active is not None:
            if (
                str(active.cloud_project_id) == str(cloud_project_id)
                and not active.loop_item_id
            ):
                if values.task_title and active.task_title != values.task_title:
                    active.task_title = values.task_title
                db.commit()
                db.refresh(active)
                return active
            active.unlinked_at = self._now()
        binding = LoopItemTaskBinding(
            cloud_project_id=cloud_project_id,
            loop_item_id=None,
            task_user_id=user_id,
            device_id=values.device_id,
            task_id=values.task_id,
            task_title=values.task_title,
            backend_task_id=values.backend_task_id,
            linked_by_user_id=user_id,
        )
        db.add(binding)
        db.commit()
        db.refresh(binding)
        return binding

    def find_cloud_context(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        task_id: str,
    ) -> tuple[LoopItemTaskBinding, CloudProject, LoopItem | None]:
        binding = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.task_user_id == user_id,
                LoopItemTaskBinding.device_id == device_id,
                LoopItemTaskBinding.task_id == task_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .first()
        )
        if binding is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud context not found")
        project = db.get(CloudProject, binding.cloud_project_id)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
        require_cloud_project_role(db, project.id, user_id, BaseRole.RestrictedAnalyst)
        item = db.get(LoopItem, binding.loop_item_id) if binding.loop_item_id else None
        return binding, project, item

    def unbind_cloud_context(
        self, db: Session, values: LoopItemTaskBind, user_id: int
    ) -> None:
        binding = self._active_task_binding(db, values, user_id, lock=True)
        if binding is None:
            return
        binding.unlinked_at = self._now()
        db.commit()

    @staticmethod
    def _validate_backend_task(
        db: Session, backend_task_id: int | None, user_id: int
    ) -> None:
        if backend_task_id is None:
            return
        backend_task = task_store.get_task_by_states(
            db,
            task_id=backend_task_id,
            states=TaskResource.is_active_query(),
            user_id=user_id,
        )
        if backend_task is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")

    @staticmethod
    def _active_task_binding(
        db: Session,
        values: LoopItemTaskBind,
        user_id: int,
        *,
        lock: bool,
    ) -> LoopItemTaskBinding | None:
        query = db.query(LoopItemTaskBinding).filter(
            LoopItemTaskBinding.task_user_id == user_id,
            LoopItemTaskBinding.device_id == values.device_id,
            LoopItemTaskBinding.task_id == values.task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        if lock:
            query = query.with_for_update()
        return query.first()

    @staticmethod
    def _advance_task_started_item(db: Session, item_id: str) -> None:
        """Move an unstarted TODO to in progress when execution is attached."""

        updates = adapt_loop_node_values_for_dialect(
            {"status": "in_progress", "completed_at": None},
            db.get_bind().dialect.name,
        )
        db.query(LoopItem).filter(
            LoopItem.id == item_id,
            LoopItem.status.in_(("inbox", "pending")),
        ).update(
            {
                **updates,
                "version": LoopItem.version + 1,
            },
            synchronize_session=False,
        )

    def list_task_bindings(
        self, db: Session, item_id: str, user_id: int
    ) -> list[LoopItemTaskBinding]:
        self.get(db, item_id, user_id)
        return (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.loop_item_id == item_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .order_by(LoopItemTaskBinding.linked_at.desc())
            .all()
        )

    def unbind_task(
        self,
        db: Session,
        item_id: str,
        values: LoopItemTaskBind,
        user_id: int,
    ) -> None:
        self.get(db, item_id, user_id)
        binding = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.loop_item_id == item_id,
                LoopItemTaskBinding.task_user_id == user_id,
                LoopItemTaskBinding.device_id == values.device_id,
                LoopItemTaskBinding.task_id == values.task_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .with_for_update()
            .first()
        )
        if binding is None:
            return
        binding.unlinked_at = self._now()
        db.commit()

    def find_for_runtime_task(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        task_id: str,
    ) -> LoopItem:
        binding = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.task_user_id == user_id,
                LoopItemTaskBinding.device_id == device_id,
                LoopItemTaskBinding.task_id == task_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .first()
        )
        if binding is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Linked TODO not found")
        return self.get(db, binding.loop_item_id, user_id)

    def list_my_work(self, db: Session, user_id: int) -> list[dict[str, object]]:
        memberships = select(ResourceMember.resource_id).where(
            ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        projects = (
            db.query(CloudProject)
            .filter(
                CloudProject.status == "active",
                (CloudProject.created_by_user_id == user_id)
                | CloudProject.id.in_(memberships),
            )
            .all()
        )
        if not projects:
            return []
        project_by_id = {project.id: project for project in projects}
        active_task_items = {
            item_id
            for (item_id,) in db.query(LoopItemTaskBinding.loop_item_id)
            .filter(
                LoopItemTaskBinding.task_user_id == user_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .all()
            if item_id
        }
        collaborator_items = {
            item_id
            for (item_id,) in db.query(LoopItemCollaborator.loop_item_id)
            .filter(LoopItemCollaborator.user_id == user_id)
            .all()
        }
        items = (
            db.query(LoopItem)
            .filter(
                LoopItem.cloud_project_id.in_(project_by_id),
                loop_datetime_is_unset(LoopItem.deleted_at),
                (LoopItem.assignee_user_id == user_id)
                | LoopItem.id.in_(active_task_items)
                | LoopItem.id.in_(collaborator_items),
            )
            .order_by(LoopItem.updated_at.desc())
            .all()
        )
        return [
            {
                **item.__dict__,
                "project_key": project_by_id[item.cloud_project_id].project_key,
                "project_name": project_by_id[item.cloud_project_id].name,
                "has_active_task": item.id in active_task_items,
            }
            for item in items
        ]

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc).replace(tzinfo=None)


loop_item_service = LoopItemService()
