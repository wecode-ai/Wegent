# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared cloud workspace file operations."""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import PurePosixPath
from typing import BinaryIO

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from app.core.config import settings
from app.models.cloud_project import CloudProjectFile
from app.models.delivery import Delivery, DeliveryAsset, LoopItem
from app.schemas.base_role import BaseRole
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.delivery.storage import DeliveryStorage, delivery_storage


def normalize_cloud_path(value: str) -> str:
    normalized = value.replace("\\", "/").strip("/")
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or ".." in path.parts:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid path")
    if any(part in {"", "."} for part in path.parts):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid path")
    return path.as_posix()


class CloudFileService:
    def __init__(self, storage: DeliveryStorage = delivery_storage) -> None:
        self.storage = storage

    def list(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        prefix: str | None = None,
    ) -> list[CloudProjectFile]:
        require_cloud_project_role(db, cloud_project_id, user_id)
        query = db.query(CloudProjectFile).filter(
            CloudProjectFile.cloud_project_id == cloud_project_id
        )
        if prefix:
            safe_prefix = normalize_cloud_path(prefix)
            query = query.filter(
                (CloudProjectFile.path == safe_prefix)
                | CloudProjectFile.path.like(f"{safe_prefix}/%")
            )
        return query.order_by(CloudProjectFile.kind.desc(), CloudProjectFile.path).all()

    def list_delivery_files(
        self, db: Session, cloud_project_id: int, user_id: int
    ) -> list[tuple[DeliveryAsset, Delivery, LoopItem]]:
        require_cloud_project_role(db, cloud_project_id, user_id)
        asset = aliased(DeliveryAsset)
        delivery = aliased(Delivery)
        item = aliased(LoopItem)
        return (
            db.query(asset, delivery, item)
            .join(delivery, delivery.id == asset.delivery_id)
            .join(item, item.id == delivery.loop_item_id)
            .filter(
                item.cloud_project_id == str(cloud_project_id),
                delivery.status == "delivered",
            )
            .order_by(
                delivery.delivered_at.desc(),
                item.sequence_number,
                asset.relative_path,
            )
            .all()
        )

    def create_folder(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        path: str,
        description: str = "",
    ) -> CloudProjectFile:
        require_cloud_project_role(db, cloud_project_id, user_id, BaseRole.Developer)
        safe_path = normalize_cloud_path(path)
        folder = CloudProjectFile(
            cloud_project_id=cloud_project_id,
            path=safe_path,
            name=PurePosixPath(safe_path).name,
            kind="folder",
            description=description,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
        )
        db.add(folder)
        self._commit_new(db, "Cloud path already exists")
        db.refresh(folder)
        return folder

    def upload(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        path: str,
        content_type: str,
        source: BinaryIO,
    ) -> CloudProjectFile:
        access = require_cloud_project_role(
            db, cloud_project_id, user_id, BaseRole.Developer
        )
        safe_path = normalize_cloud_path(path)
        existing = (
            db.query(CloudProjectFile)
            .filter(
                CloudProjectFile.cloud_project_id == cloud_project_id,
                CloudProjectFile.path == safe_path,
            )
            .first()
        )
        if existing is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Cloud path already exists")

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
                        "Cloud workspace file is too large",
                    )
            staged.seek(0)
            object_key = f"{access.project.storage_prefix}/shared/{safe_path}"
            self.storage.put_stream(object_key, staged, length, content_type)

        file = CloudProjectFile(
            cloud_project_id=cloud_project_id,
            path=safe_path,
            name=PurePosixPath(safe_path).name,
            kind="file",
            object_key=object_key,
            content_type=content_type,
            size_bytes=length,
            sha256=digest.hexdigest(),
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
        )
        db.add(file)
        try:
            self._commit_new(db, "Cloud path already exists")
        except Exception:
            self.storage.remove_objects([object_key])
            raise
        db.refresh(file)
        return file

    def get(self, db: Session, file_id: int, user_id: int) -> CloudProjectFile:
        file = db.get(CloudProjectFile, file_id)
        if file is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud file not found")
        require_cloud_project_role(db, file.cloud_project_id, user_id)
        return file

    def access_url(self, db: Session, file_id: int, user_id: int) -> str:
        file = self.get(db, file_id, user_id)
        if file.kind != "file" or not file.object_key:
            raise HTTPException(status.HTTP_409_CONFLICT, "Path is not a file")
        return self.storage.download_url(file.object_key)

    def move(
        self,
        db: Session,
        file_id: int,
        user_id: int,
        path: str,
        version: int,
    ) -> CloudProjectFile:
        file = self.get(db, file_id, user_id)
        access = require_cloud_project_role(
            db, file.cloud_project_id, user_id, BaseRole.Developer
        )
        if file.version != version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Cloud file changed")
        target_path = normalize_cloud_path(path)
        if target_path == file.path:
            return file
        descendants = (
            db.query(CloudProjectFile)
            .filter(
                CloudProjectFile.cloud_project_id == file.cloud_project_id,
                CloudProjectFile.path.like(f"{file.path}/%"),
            )
            .all()
            if file.kind == "folder"
            else []
        )
        moving = [file, *descendants]
        target_paths = {
            entry.id: target_path + entry.path[len(file.path) :] for entry in moving
        }
        moving_ids = [entry.id for entry in moving]
        conflict = (
            db.query(CloudProjectFile.id)
            .filter(
                CloudProjectFile.cloud_project_id == file.cloud_project_id,
                CloudProjectFile.id.notin_(moving_ids),
                CloudProjectFile.path.in_(list(target_paths.values())),
            )
            .first()
        )
        if conflict:
            raise HTTPException(status.HTTP_409_CONFLICT, "Cloud path already exists")

        copied: list[tuple[str, str]] = []
        try:
            for entry in moving:
                if not entry.object_key:
                    continue
                target_key = (
                    f"{access.project.storage_prefix}/shared/{target_paths[entry.id]}"
                )
                self.storage.copy_object(entry.object_key, target_key)
                copied.append((entry.object_key, target_key))
                entry.object_key = target_key
        except Exception:
            self.storage.remove_objects([target for _, target in copied])
            raise
        for entry in moving:
            entry.path = target_paths[entry.id]
            entry.name = PurePosixPath(entry.path).name
            entry.updated_by_user_id = user_id
            entry.version += 1
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            self.storage.remove_objects([target for _, target in copied])
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Cloud path already exists"
            ) from exc
        except Exception:
            db.rollback()
            self.storage.remove_objects([target for _, target in copied])
            raise
        self.storage.remove_objects([source for source, _ in copied])
        db.refresh(file)
        return file

    def delete(
        self, db: Session, file_id: int, user_id: int, recursive: bool = False
    ) -> None:
        file = self.get(db, file_id, user_id)
        require_cloud_project_role(
            db, file.cloud_project_id, user_id, BaseRole.Developer
        )
        if file.kind == "folder":
            children = (
                db.query(CloudProjectFile)
                .filter(
                    CloudProjectFile.cloud_project_id == file.cloud_project_id,
                    CloudProjectFile.path.like(f"{file.path}/%"),
                )
                .all()
            )
            if children and not recursive:
                raise HTTPException(status.HTTP_409_CONFLICT, "Folder is not empty")
        else:
            children = []
        object_keys = [
            entry.object_key for entry in [file, *children] if entry.object_key
        ]
        if object_keys:
            self.storage.remove_objects(object_keys)
        for child in children:
            db.delete(child)
        db.delete(file)
        db.commit()

    @staticmethod
    def _commit_new(db: Session, detail: str) -> None:
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, detail) from exc


cloud_file_service = CloudFileService()
