# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Business logic for immutable TODO delivery snapshots."""

import hashlib
import json
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any, BinaryIO

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.cloud_project import CloudProject, LoopItemTaskBinding
from app.models.delivery import (
    Delivery,
    DeliveryAsset,
    LoopItem,
    loop_datetime_is_unset,
)
from app.schemas.base_role import BaseRole
from app.schemas.delivery import DeliveryCreate, LoopItemTaskBind
from app.services.delivery.access import require_loop_item_access
from app.services.delivery.storage import (
    DeliveryStorage,
    DeliveryStorageUnavailableError,
    delivery_storage,
)

MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
MAX_CHAT_BYTES = 10 * 1024 * 1024


def _safe_relative_path(value: str) -> str:
    normalized = value.replace("\\", "/").strip("/")
    path = PurePosixPath(normalized)
    if (
        not normalized
        or len(normalized) > 700
        or path.is_absolute()
        or ".." in path.parts
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid asset path")
    return path.as_posix()


def _delivery_prefix(project_public_id: str, item_id: str, delivery_id: str) -> str:
    return f"projects/{project_public_id}/loop-items/{item_id}/deliveries/{delivery_id}"


class DeliveryService:
    """Coordinate SQL metadata and the MinIO snapshot boundary."""

    def __init__(self, storage: DeliveryStorage = delivery_storage) -> None:
        self.storage = storage

    def create_delivery(
        self,
        db: Session,
        item_id: str,
        user_id: int,
        values: DeliveryCreate,
    ) -> Delivery:
        item = require_loop_item_access(db, item_id, user_id, BaseRole.Developer)
        if item.status == "completed":
            raise HTTPException(status.HTTP_409_CONFLICT, "TODO is already completed")
        markdown = values.markdown.encode()
        chat = (
            json.dumps(values.chat, ensure_ascii=False).encode()
            if values.chat
            else None
        )
        if len(markdown) > MAX_MARKDOWN_BYTES or (chat and len(chat) > MAX_CHAT_BYTES):
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE, "Delivery text is too large"
            )

        project = db.get(CloudProject, item.cloud_project_id)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
        source_binding, source_snapshot = self._resolve_source_task(
            db, item, values.source_task, user_id
        )
        delivery_id = str(uuid.uuid4())
        prefix = _delivery_prefix(project.public_id, item.id, delivery_id)
        markdown_key = f"{prefix}/markdown.md"
        chat_key = f"{prefix}/chat.json" if chat is not None else None
        written: list[str] = []
        try:
            self.storage.put_bytes(
                markdown_key, markdown, "text/markdown; charset=utf-8"
            )
            written.append(markdown_key)
            if chat_key and chat is not None:
                self.storage.put_bytes(chat_key, chat, "application/json")
                written.append(chat_key)
            delivery = Delivery(
                id=delivery_id,
                loop_item_id=item.id,
                created_by_user_id=user_id,
                source_task_binding_id=(
                    source_binding.id if source_binding is not None else None
                ),
                source_task_snapshot=source_snapshot,
                status="draft",
                markdown_object_key=markdown_key,
                chat_object_key=chat_key,
            )
            from app.services.loop_items import loop_item_service

            loop_item_service.ensure_collaborator(
                db, item, user_id, user_id, "delivery", commit=False
            )
            db.add(delivery)
            db.commit()
            db.refresh(delivery)
            return delivery
        except DeliveryStorageUnavailableError as exc:
            db.rollback()
            if written:
                self.storage.remove_objects(written)
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Delivery object storage is unavailable",
            ) from exc
        except Exception:
            db.rollback()
            if written:
                self.storage.remove_objects(written)
            raise

    def add_asset(
        self,
        db: Session,
        delivery_id: str,
        user_id: int,
        relative_path: str,
        display_name: str,
        content_type: str,
        source: BinaryIO,
    ) -> DeliveryAsset:
        delivery = self._require_delivery(db, delivery_id, user_id, draft=True)
        safe_path = _safe_relative_path(relative_path)
        if (
            db.query(DeliveryAsset.id)
            .filter(
                DeliveryAsset.delivery_id == delivery_id,
                DeliveryAsset.relative_path == safe_path,
            )
            .first()
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "Asset path already exists")

        digest = hashlib.sha256()
        length = 0
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as staged:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                staged.write(chunk)
                length += len(chunk)
                if length > settings.DELIVERY_MAX_ASSET_SIZE_MB * 1024 * 1024:
                    raise HTTPException(
                        status.HTTP_413_CONTENT_TOO_LARGE,
                        "Delivery asset is too large",
                    )
            staged.seek(0)
            prefix = self._delivery_prefix_for(db, delivery)
            object_key = f"{prefix}/files/{safe_path}"
            self.storage.put_stream(object_key, staged, length, content_type)

        asset = DeliveryAsset(
            id=str(uuid.uuid4()),
            delivery_id=delivery.id,
            kind="file",
            display_name=display_name,
            relative_path=safe_path,
            object_key=object_key,
            content_type=content_type,
            size_bytes=length,
            sha256=digest.hexdigest(),
        )
        try:
            db.add(asset)
            db.commit()
            db.refresh(asset)
            return asset
        except Exception:
            db.rollback()
            self.storage.remove_objects([object_key])
            raise

    def discard_draft(self, db: Session, delivery_id: str, user_id: int) -> None:
        delivery = self._require_delivery(db, delivery_id, user_id, draft=True)
        if delivery.created_by_user_id != user_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Only the creator can discard a draft"
            )
        object_keys = [delivery.markdown_object_key]
        if delivery.chat_object_key:
            object_keys.append(delivery.chat_object_key)
        object_keys.extend(
            asset.object_key for asset in self.list_assets(db, delivery.id)
        )
        self.storage.remove_objects(object_keys)
        db.delete(delivery)
        db.commit()

    def finalize(self, db: Session, delivery_id: str, user_id: int) -> Delivery:
        delivery = self._require_delivery(db, delivery_id, user_id, draft=True)
        item = require_loop_item_access(
            db, delivery.loop_item_id, user_id, BaseRole.Developer
        )
        if delivery.source_task_binding_id:
            self._require_active_task_binding(
                db, item.id, delivery.source_task_binding_id
            )
        assets = self.list_assets(db, delivery.id)
        manifest = {
            "version": 1,
            "deliveryId": delivery.id,
            "cloudProjectId": item.cloud_project_id,
            "loopItemId": delivery.loop_item_id,
            "sourceTask": delivery.source_task_snapshot,
            "markdown": "markdown.md",
            "chat": "chat.json" if delivery.chat_object_key else None,
            "files": [
                {
                    "path": asset.relative_path,
                    "name": asset.display_name,
                    "size": asset.size_bytes,
                    "sha256": asset.sha256,
                    "contentType": asset.content_type,
                }
                for asset in assets
            ],
        }
        manifest_key = f"{self._delivery_prefix_for(db, delivery)}/manifest.json"
        self.storage.put_json(manifest_key, manifest)
        try:
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            delivery.manifest_object_key = manifest_key
            delivery.status = "delivered"
            delivery.delivered_at = now
            item.status = "completed"
            item.current_delivery_id = delivery.id
            item.completed_at = now
            item.version += 1
            db.commit()
            db.refresh(delivery)
            return delivery
        except Exception:
            db.rollback()
            self.storage.remove_objects([manifest_key])
            raise

    def list_deliveries(
        self, db: Session, item_id: str, user_id: int
    ) -> list[Delivery]:
        require_loop_item_access(db, item_id, user_id)
        return (
            db.query(Delivery)
            .filter(Delivery.loop_item_id == item_id, Delivery.status == "delivered")
            .order_by(Delivery.delivered_at.desc())
            .all()
        )

    def get_delivery(self, db: Session, delivery_id: str, user_id: int) -> Delivery:
        return self._require_delivery(db, delivery_id, user_id)

    def list_assets(self, db: Session, delivery_id: str) -> list[DeliveryAsset]:
        return (
            db.query(DeliveryAsset)
            .filter(DeliveryAsset.delivery_id == delivery_id)
            .order_by(DeliveryAsset.relative_path)
            .all()
        )

    def access_asset_url(self, db: Session, asset_id: str, user_id: int) -> str:
        asset = db.get(DeliveryAsset, asset_id)
        if asset is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery asset not found")
        delivery = self._require_delivery(db, asset.delivery_id, user_id)
        if delivery.status != "delivered":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery asset not found")
        return self.storage.download_url(asset.object_key)

    def read_markdown(self, delivery: Delivery) -> str:
        return self.storage.get_bytes(
            delivery.markdown_object_key, MAX_MARKDOWN_BYTES
        ).decode()

    def read_chat(self, delivery: Delivery) -> dict[str, Any] | None:
        if not delivery.chat_object_key:
            return None
        return json.loads(
            self.storage.get_bytes(delivery.chat_object_key, MAX_CHAT_BYTES)
        )

    def _require_delivery(
        self, db: Session, delivery_id: str, user_id: int, draft: bool = False
    ) -> Delivery:
        query = db.query(Delivery).filter(Delivery.id == delivery_id)
        if draft:
            query = query.with_for_update()
        delivery = query.first()
        if delivery is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery not found")
        require_loop_item_access(db, delivery.loop_item_id, user_id)
        if draft and delivery.status != "draft":
            raise HTTPException(status.HTTP_409_CONFLICT, "Delivery is immutable")
        return delivery

    def _delivery_prefix_for(self, db: Session, delivery: Delivery) -> str:
        item = db.get(LoopItem, delivery.loop_item_id)
        project = db.get(CloudProject, item.cloud_project_id) if item else None
        if item is None or project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery project not found")
        return _delivery_prefix(project.public_id, item.id, delivery.id)

    def _resolve_source_task(
        self,
        db: Session,
        item: LoopItem,
        source_task: LoopItemTaskBind | None,
        user_id: int,
    ) -> tuple[LoopItemTaskBinding | None, dict[str, Any] | None]:
        if source_task is None:
            return None, None
        binding = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.loop_item_id == item.id,
                LoopItemTaskBinding.task_user_id == user_id,
                LoopItemTaskBinding.device_id == source_task.device_id,
                LoopItemTaskBinding.task_id == source_task.task_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .first()
        )
        if binding is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Source Task is not linked to this TODO",
            )
        return binding, {
            "taskId": binding.task_id,
            "deviceId": binding.device_id,
            "userId": binding.task_user_id,
            "backendTaskId": binding.backend_task_id,
        }

    @staticmethod
    def _require_active_task_binding(
        db: Session, item_id: str, binding_id: int
    ) -> LoopItemTaskBinding:
        binding = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.loop_item_id == item_id,
                LoopItemTaskBinding.id == binding_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .first()
        )
        if binding is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Source Task is not linked to this TODO",
            )
        return binding


delivery_service = DeliveryService()
