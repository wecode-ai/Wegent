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
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.delivery import (
    DeliveryChatSelection,
    DeliveryCreate,
    DeliveryFinalize,
    DeliveryFulfillment,
    LoopItemTaskBind,
)
from app.schemas.issue_workflow import workflow_node_execution_mode
from app.services.delivery.access import require_loop_item_access
from app.services.delivery.storage import (
    DeliveryStorage,
    DeliveryStorageUnavailableError,
    delivery_storage,
)
from app.services.loop_item_events import publish_loop_item_changed
from app.services.loop_item_status_history import write_status_change
from app.services.loop_item_unread import advance_content_revision

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
        chat_snapshot = values.chat or self._select_chat_messages(
            db, item, values.chat_selection
        )
        chat = (
            json.dumps(chat_snapshot, ensure_ascii=False).encode()
            if chat_snapshot is not None
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

    @staticmethod
    def _select_chat_messages(
        db: Session,
        item: LoopItem,
        selection: DeliveryChatSelection | None,
    ) -> dict[str, Any] | None:
        if selection is None:
            return None
        query = db.query(ProjectChatMessage).filter(
            ProjectChatMessage.project_id == str(item.cloud_project_id),
            ProjectChatMessage.task_id == item.id,
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        if selection.mode == "latest":
            rows = (
                query.order_by(ProjectChatMessage.id.desc())
                .limit(selection.count or 1)
                .all()
            )
            rows.reverse()
        elif selection.mode == "message_ids":
            rows = (
                query.filter(ProjectChatMessage.message_id.in_(selection.message_ids))
                .order_by(ProjectChatMessage.id.asc())
                .all()
            )
            found = {row.message_id for row in rows}
            missing = [
                message_id
                for message_id in selection.message_ids
                if message_id not in found
            ]
            if missing:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND,
                    f"Chat messages not found: {', '.join(missing)}",
                )
        else:
            rows = query.order_by(ProjectChatMessage.id.asc()).all()
        from app.services.project_chat.service import project_chat_service

        return {
            "selection": selection.model_dump(mode="json"),
            "messages": [
                project_chat_service.to_view(row).model_dump(mode="json")
                for row in rows
            ],
        }

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

    def finalize(
        self,
        db: Session,
        delivery_id: str,
        user_id: int,
        values: DeliveryFinalize,
    ) -> Delivery:
        delivery = self._require_delivery(db, delivery_id, user_id, draft=True)
        authorized_item = require_loop_item_access(
            db, delivery.loop_item_id, user_id, BaseRole.Developer
        )
        item = (
            db.query(LoopItem)
            .filter(LoopItem.id == authorized_item.id)
            .with_for_update()
            .first()
        )
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
        source_binding = None
        if delivery.source_task_binding_id:
            source_binding = self._require_active_task_binding(
                db, item.id, delivery.source_task_binding_id
            )
        assets = self.list_assets(db, delivery.id)
        workflow_node = self._workflow_node(item, source_binding)
        fulfillments = self._validate_fulfillments(
            workflow_node,
            assets,
            values.fulfillments,
        )
        delivery.metadata_json = {
            **(
                delivery.metadata_json
                if isinstance(delivery.metadata_json, dict)
                else {}
            ),
            "fulfillments": fulfillments,
        }
        manifest = {
            "version": 2,
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
            "fulfillments": fulfillments,
        }
        manifest_key = f"{self._delivery_prefix_for(db, delivery)}/manifest.json"
        self.storage.put_json(manifest_key, manifest)
        try:
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            delivery.manifest_object_key = manifest_key
            delivery.status = "delivered"
            delivery.delivered_at = now
            if source_binding is not None and source_binding.workflow_node_id:
                db.flush()
                self._attach_workflow_delivery(
                    item,
                    workflow_node_id=source_binding.workflow_node_id,
                    delivery_id=delivery.id,
                )
                self._complete_automated_node_if_fulfilled(
                    db,
                    item,
                    source_binding.workflow_node_id,
                )
                item.current_delivery_id = delivery.id
                item.metadata_json = advance_content_revision(
                    item.metadata_json, actor_user_id=user_id
                )
                item.version += 1
                db.commit()
                db.refresh(delivery)
                publish_loop_item_changed(
                    db,
                    item=item,
                    reason="delivery_finalized",
                    actor_user_id=user_id,
                )
                return delivery
            if item.status != "completed":
                project = db.get(CloudProject, item.cloud_project_id)
                if project is not None:
                    metadata = (
                        dict(item.metadata_json)
                        if isinstance(item.metadata_json, dict)
                        else {}
                    )
                    write_status_change(
                        metadata,
                        project=project,
                        from_status=item.status,
                        to_status="completed",
                        trigger="delivery",
                        by_user_id=user_id,
                    )
                    item.metadata_json = metadata
            item.status = "completed"
            item.current_delivery_id = delivery.id
            item.completed_at = now
            item.metadata_json = advance_content_revision(
                item.metadata_json, actor_user_id=user_id
            )
            item.version += 1
            db.commit()
            db.refresh(delivery)
            publish_loop_item_changed(
                db,
                item=item,
                reason="delivery_finalized",
                actor_user_id=user_id,
            )
            return delivery
        except Exception:
            db.rollback()
            self.storage.remove_objects([manifest_key])
            raise

    @staticmethod
    def _workflow_node(
        item: LoopItem,
        source_binding: LoopItemTaskBinding | None,
    ) -> dict[str, Any] | None:
        if source_binding is None or not source_binding.workflow_node_id:
            return None
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        workflow = metadata.get("workflow")
        nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        if not isinstance(nodes, list):
            raise HTTPException(status.HTTP_409_CONFLICT, "Issue has no workflow")
        node = next(
            (
                dict(candidate)
                for candidate in nodes
                if isinstance(candidate, dict)
                and candidate.get("id") == source_binding.workflow_node_id
            ),
            None,
        )
        if node is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workflow node not found")
        return node

    @staticmethod
    def _validate_fulfillments(
        node: dict[str, Any] | None,
        assets: list[DeliveryAsset],
        values: list[DeliveryFulfillment],
    ) -> list[dict[str, Any]]:
        if node is None:
            if values:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "Deliverable fulfillments require a workflow stage",
                )
            return []
        requirements = {
            str(requirement.get("id")): requirement
            for requirement in node.get("required_deliverables") or []
            if isinstance(requirement, dict) and requirement.get("id")
        }
        if requirements and not values:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Workflow Delivery must fulfill at least one required deliverable",
            )
        assets_by_id = {asset.id: asset for asset in assets}
        serialized: list[dict[str, Any]] = []
        for fulfillment in values:
            requirement = requirements.get(fulfillment.requirement_id)
            if requirement is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    f"Unknown workflow deliverable requirement: "
                    f"{fulfillment.requirement_id}",
                )
            if requirement.get("value_type") != fulfillment.kind:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    f"Workflow deliverable type mismatch: "
                    f"{fulfillment.requirement_id}",
                )
            DeliveryService._validate_fulfillment_assets(
                requirement,
                fulfillment,
                assets_by_id,
            )
            serialized.append(fulfillment.model_dump(mode="json"))
        return serialized

    @staticmethod
    def _validate_fulfillment_assets(
        requirement: dict[str, Any],
        fulfillment: DeliveryFulfillment,
        assets_by_id: dict[str, DeliveryAsset],
    ) -> None:
        if fulfillment.kind == "file":
            selected = [
                assets_by_id.get(asset_id) for asset_id in fulfillment.asset_ids
            ]
            if any(asset is None for asset in selected):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "File fulfillment references an asset outside this Delivery",
                )
            constraints = requirement.get("file_constraints") or {}
            minimum = int(constraints.get("min_files") or 1)
            maximum = int(constraints.get("max_files") or 1)
            if not minimum <= len(selected) <= maximum:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "File fulfillment count does not satisfy the requirement",
                )
            accepted = constraints.get("accepted_types") or []
            if accepted and any(
                not DeliveryService._asset_matches(asset, accepted)
                for asset in selected
                if asset is not None
            ):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "File fulfillment type does not satisfy the requirement",
                )
        elif fulfillment.kind == "code_snapshot":
            asset = assets_by_id.get(fulfillment.asset_id)
            if asset is None or asset.sha256 != fulfillment.sha256:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "Code snapshot does not match this Delivery asset",
                )

    @staticmethod
    def _asset_matches(asset: DeliveryAsset, accepted: list[str]) -> bool:
        content_type = str(asset.content_type or "").lower()
        display_name = str(asset.display_name or "").lower()
        for raw_pattern in accepted:
            pattern = str(raw_pattern).strip().lower()
            if not pattern:
                continue
            if pattern.startswith(".") and display_name.endswith(pattern):
                return True
            if pattern.endswith("/*") and content_type.startswith(pattern[:-1]):
                return True
            if content_type == pattern:
                return True
        return False

    @staticmethod
    def _complete_automated_node_if_fulfilled(
        db: Session,
        item: LoopItem,
        workflow_node_id: str,
    ) -> None:
        from app.services.project_workflow_projection import apply_workflow_nodes
        from app.services.workflow_deliverables import missing_requirement_ids

        metadata = dict(item.metadata_json or {})
        workflow = metadata.get("workflow")
        raw_nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        if not isinstance(raw_nodes, list):
            return
        nodes = [dict(node) if isinstance(node, dict) else {} for node in raw_nodes]
        node = next(
            (
                candidate
                for candidate in nodes
                if candidate.get("id") == workflow_node_id
            ),
            None,
        )
        if (
            node is None
            or workflow_node_execution_mode(node) != "robot"
            or node.get("status") != "awaiting_deliverables"
            or missing_requirement_ids(db, node)
        ):
            return
        node["status"] = "completed"
        apply_workflow_nodes(item, workflow=workflow, nodes=nodes)

    @staticmethod
    def fulfillment_values(delivery: Delivery) -> list[dict[str, Any]]:
        metadata = (
            delivery.metadata_json if isinstance(delivery.metadata_json, dict) else {}
        )
        values = metadata.get("fulfillments")
        if not isinstance(values, list):
            return []
        return [dict(value) for value in values if isinstance(value, dict)]

    @staticmethod
    def _attach_workflow_delivery(
        item: LoopItem,
        *,
        workflow_node_id: str,
        delivery_id: str,
    ) -> None:
        metadata = dict(item.metadata_json or {})
        workflow = metadata.get("workflow")
        raw_nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        if not isinstance(raw_nodes, list):
            raise HTTPException(status.HTTP_409_CONFLICT, "Issue has no workflow")
        nodes: list[dict] = []
        found = False
        for raw_node in raw_nodes:
            node = dict(raw_node) if isinstance(raw_node, dict) else {}
            if node.get("id") == workflow_node_id:
                delivery_ids = list(node.get("delivery_ids") or [])
                if delivery_id not in delivery_ids:
                    delivery_ids.append(delivery_id)
                node["delivery_ids"] = delivery_ids
                found = True
            nodes.append(node)
        if not found:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workflow node not found")
        next_workflow = dict(workflow)
        next_workflow["version"] = int(workflow.get("version") or 1) + 1
        next_workflow["nodes"] = nodes
        metadata["workflow"] = next_workflow
        item.metadata_json = metadata

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

    def read_asset_content(
        self, db: Session, asset_id: str, user_id: int
    ) -> tuple[bytes, str, str]:
        asset = db.get(DeliveryAsset, asset_id)
        if asset is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery asset not found")
        delivery = self._require_delivery(db, asset.delivery_id, user_id)
        if delivery.status != "delivered":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery asset not found")
        content = self.storage.get_bytes(
            asset.object_key,
            settings.DELIVERY_MAX_ASSET_SIZE_MB * 1024 * 1024,
        )
        filename = asset.display_name or asset.relative_path
        return content, asset.content_type or "application/octet-stream", filename

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
