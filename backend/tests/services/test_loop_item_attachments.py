# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for project-space task attachment aggregation."""

import io
import uuid
from datetime import datetime
from typing import BinaryIO

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, LoopItemAttachment
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.services.attachment.storage_backend import generate_storage_key
from app.services.loop_items import loop_item_service


class FakeDeliveryStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_stream(
        self,
        object_key: str,
        stream: BinaryIO,
        length: int,
        content_type: str,
    ) -> None:
        self.objects[object_key] = stream.read(length)

    def get_bytes(self, object_key: str, max_bytes: int | None = None) -> bytes:
        data = self.objects[object_key]
        if max_bytes is not None and len(data) > max_bytes:
            raise ValueError("Delivery object exceeds the readable size limit")
        return data

    def download_url(self, object_key: str, expires_seconds: int = 900) -> str:
        return f"https://storage.test/{object_key}"

    def remove_objects(self, object_keys: list[str]) -> None:
        for key in object_keys:
            self.objects.pop(key, None)

    def copy_object(self, source_key: str, target_key: str) -> None:
        self.objects[target_key] = self.objects[source_key]


@pytest.fixture
def attachment_storage(monkeypatch: pytest.MonkeyPatch) -> FakeDeliveryStorage:
    storage = FakeDeliveryStorage()
    monkeypatch.setattr("app.services.loop_items.service.delivery_storage", storage)
    return storage


def _make_project(db: Session, user: User, key: str) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=key,
        name=key,
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_item(db: Session, project: CloudProject, user: User, title: str) -> LoopItem:
    return loop_item_service.create(
        db,
        project.id,
        user.id,
        LoopItemCreate(title=title),
    )


def _make_attachment(
    db: Session,
    item: LoopItem,
    user: User,
    name: str,
    data: bytes = b"attachment",
    *,
    metadata: dict | None = None,
) -> LoopItemAttachment:
    project = db.get(CloudProject, item.cloud_project_id)
    assert project is not None
    return loop_item_service._store_attachment(
        db,
        item,
        project,
        user.id,
        name,
        "application/octet-stream",
        io.BytesIO(data),
        100,
        metadata=metadata,
    )


def _make_context(
    db: Session,
    user: User,
    *,
    name: str = "conversation.png",
    data: bytes = b"context",
    status: str = ContextStatus.READY.value,
) -> SubtaskContext:
    context = SubtaskContext(
        user_id=user.id,
        context_type=ContextType.ATTACHMENT.value,
        name=name,
        status=status,
        binary_data=data,
        type_data={
            "original_filename": name,
            "file_extension": name.rsplit(".", 1)[-1] if "." in name else "",
            "mime_type": "image/png",
            "storage_backend": "mysql",
        },
    )
    db.add(context)
    db.commit()
    db.refresh(context)
    context.type_data = {
        **context.type_data,
        "storage_key": generate_storage_key(context.id, user.id),
    }
    db.commit()
    db.refresh(context)
    return context


def test_list_project_attachments_aggregates_tasks_and_excludes_deleted(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
) -> None:
    project = _make_project(test_db, test_user, "ATT1")
    other_project = _make_project(test_db, test_user, "ATT2")
    item = _make_item(test_db, project, test_user, "Report")
    other_item = _make_item(test_db, other_project, test_user, "Other")
    _make_attachment(test_db, item, test_user, "report.txt", b"report")
    _make_attachment(test_db, other_item, test_user, "other.txt", b"other")

    rows = loop_item_service.list_project_attachments(
        test_db, int(project.id), test_user.id
    )

    assert [(attachment.display_name, item.title) for attachment, item in rows] == [
        ("report.txt", "Report")
    ]

    item.deleted_at = datetime(2026, 8, 17)
    test_db.commit()

    assert (
        loop_item_service.list_project_attachments(
            test_db, int(project.id), test_user.id
        )
        == []
    )


def test_import_context_attachments_copies_and_deduplicates(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
) -> None:
    project = _make_project(test_db, test_user, "ATTI")
    item = _make_item(test_db, project, test_user, "Report")
    context = _make_context(test_db, test_user, name="context.png", data=b"context")

    imported = loop_item_service.import_context_attachments(
        test_db, item.id, test_user.id, [context.id]
    )
    imported_again = loop_item_service.import_context_attachments(
        test_db, item.id, test_user.id, [context.id]
    )

    assert [entry.display_name for entry in imported] == ["context.png"]
    assert imported_again == []
    assert imported[0].metadata_json == {"source_context_id": context.id}
    assert attachment_storage.get_bytes(imported[0].object_key) == b"context"
    listed = loop_item_service.list_attachments(test_db, item.id, test_user.id)
    assert len(listed) == 1


def test_import_context_attachments_rejects_not_ready_context(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
) -> None:
    project = _make_project(test_db, test_user, "ATTP")
    item = _make_item(test_db, project, test_user, "Report")
    context = _make_context(
        test_db,
        test_user,
        name="pending.png",
        data=b"pending",
        status=ContextStatus.PENDING.value,
    )

    with pytest.raises(HTTPException) as exc:
        loop_item_service.import_context_attachments(
            test_db, item.id, test_user.id, [context.id]
        )

    assert exc.value.status_code == 422


def test_import_context_attachments_returns_not_found_for_unknown_context(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
) -> None:
    project = _make_project(test_db, test_user, "ATTN")
    item = _make_item(test_db, project, test_user, "Report")

    with pytest.raises(HTTPException) as exc:
        loop_item_service.import_context_attachments(
            test_db, item.id, test_user.id, [999_999_999]
        )

    assert exc.value.status_code == 404


def test_add_generated_image_attachment_deduplicates_by_source_call_id(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
) -> None:
    project = _make_project(test_db, test_user, "ATTG")
    item = _make_item(test_db, project, test_user, "Report")

    first = loop_item_service.add_generated_image_attachment(
        test_db,
        item.id,
        test_user.id,
        "image_0.png",
        "image/png",
        b"image",
        "image-call:0",
    )
    second = loop_item_service.add_generated_image_attachment(
        test_db,
        item.id,
        test_user.id,
        "image_0.png",
        "image/png",
        b"image",
        "image-call:0",
    )

    assert first.id == second.id
    assert first.metadata_json == {"source_call_id": "image-call:0"}
    assert attachment_storage.get_bytes(first.object_key) == b"image"
    assert len(loop_item_service.list_attachments(test_db, item.id, test_user.id)) == 1
