# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for shared project-space attachment capabilities."""

import io
import uuid
from datetime import datetime
from typing import BinaryIO

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, LoopItemAttachment
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.services.attachment.storage_backend import generate_storage_key
from app.services.delivery.storage import DeliveryStorageUnavailableError
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


class UnavailableDeliveryStorage(FakeDeliveryStorage):
    def put_stream(
        self,
        object_key: str,
        stream: BinaryIO,
        length: int,
        content_type: str,
    ) -> None:
        raise DeliveryStorageUnavailableError("storage unavailable")


class FailSecondDeliveryStorage(FakeDeliveryStorage):
    def __init__(self) -> None:
        super().__init__()
        self.put_calls = 0
        self.removed: list[str] = []

    def put_stream(
        self,
        object_key: str,
        stream: BinaryIO,
        length: int,
        content_type: str,
    ) -> None:
        self.put_calls += 1
        if self.put_calls == 2:
            raise DeliveryStorageUnavailableError("storage unavailable")
        super().put_stream(object_key, stream, length, content_type)

    def remove_objects(self, object_keys: list[str]) -> None:
        self.removed.extend(object_keys)
        super().remove_objects(object_keys)


class FailThirdAndFirstCleanupDeliveryStorage(FakeDeliveryStorage):
    def __init__(self) -> None:
        super().__init__()
        self.put_calls = 0
        self.cleanup_calls: list[str] = []

    def put_stream(
        self,
        object_key: str,
        stream: BinaryIO,
        length: int,
        content_type: str,
    ) -> None:
        self.put_calls += 1
        if self.put_calls == 3:
            raise DeliveryStorageUnavailableError("original upload failure")
        super().put_stream(object_key, stream, length, content_type)

    def remove_objects(self, object_keys: list[str]) -> None:
        object_key = object_keys[0]
        self.cleanup_calls.append(object_key)
        if len(self.cleanup_calls) == 1:
            raise RuntimeError("cleanup failure")
        super().remove_objects(object_keys)


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


def test_list_project_attachments_excludes_other_projects_and_deleted_items(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
) -> None:
    project = _make_project(test_db, test_user, "ATT1")
    other_project = _make_project(test_db, test_user, "ATT2")
    item = _make_item(test_db, project, test_user, "Report")
    other_item = _make_item(test_db, other_project, test_user, "Other")
    _make_attachment(test_db, item, test_user, "report.txt")
    _make_attachment(test_db, other_item, test_user, "other.txt")

    rows = loop_item_service.list_project_attachments(
        test_db, int(project.id), test_user.id
    )
    assert [(attachment.display_name, row.title) for attachment, row in rows] == [
        ("report.txt", "Report")
    ]

    item.deleted_at = datetime(2026, 9, 9)
    test_db.commit()
    assert (
        loop_item_service.list_project_attachments(
            test_db, int(project.id), test_user.id
        )
        == []
    )


def test_import_context_attachments_copies_once(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _make_project(test_db, test_user, "ATTI")
    item = _make_item(test_db, project, test_user, "Report")
    context = _make_context(test_db, test_user)
    commit_calls = 0
    original_commit = test_db.commit

    def track_commit() -> None:
        nonlocal commit_calls
        commit_calls += 1
        original_commit()

    monkeypatch.setattr(test_db, "commit", track_commit)

    imported = loop_item_service.import_context_attachments(
        test_db, item.id, test_user.id, [context.id]
    )
    imported_again = loop_item_service.import_context_attachments(
        test_db, item.id, test_user.id, [context.id]
    )

    assert [entry.display_name for entry in imported] == ["conversation.png"]
    assert imported_again == []
    assert imported[0].source_context_id == context.id
    assert imported[0].metadata_json == {"source_context_id": context.id}
    assert attachment_storage.get_bytes(imported[0].object_key) == b"context"
    assert commit_calls == 1


def test_import_context_attachments_rejects_unready_context(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
) -> None:
    project = _make_project(test_db, test_user, "ATTP")
    item = _make_item(test_db, project, test_user, "Report")
    context = _make_context(
        test_db,
        test_user,
        status=ContextStatus.PENDING.value,
    )

    with pytest.raises(HTTPException) as exc:
        loop_item_service.import_context_attachments(
            test_db, item.id, test_user.id, [context.id]
        )

    assert exc.value.status_code == 422


def test_import_context_attachments_validates_all_contexts_before_writing(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
) -> None:
    project = _make_project(test_db, test_user, "ATTV")
    item = _make_item(test_db, project, test_user, "Validate first")
    valid = _make_context(test_db, test_user, name="valid.txt", data=b"valid")
    missing_context_id = valid.id + 100_000

    with pytest.raises(HTTPException) as exc:
        loop_item_service.import_context_attachments(
            test_db,
            item.id,
            test_user.id,
            [valid.id, missing_context_id],
        )

    assert exc.value.status_code == 404
    assert attachment_storage.objects == {}
    assert (
        test_db.query(LoopItemAttachment)
        .filter(LoopItemAttachment.loop_item_id == item.id)
        .count()
        == 0
    )


def test_import_context_attachments_cleans_batch_when_second_upload_fails(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _make_project(test_db, test_user, "ATTF")
    item = _make_item(test_db, project, test_user, "Atomic upload")
    first = _make_context(test_db, test_user, name="first.txt", data=b"first")
    second = _make_context(test_db, test_user, name="second.txt", data=b"second")
    storage = FailSecondDeliveryStorage()
    monkeypatch.setattr(
        "app.services.loop_items.service.delivery_storage",
        storage,
    )

    with pytest.raises(HTTPException) as exc:
        loop_item_service.import_context_attachments(
            test_db,
            item.id,
            test_user.id,
            [first.id, second.id],
        )

    assert exc.value.status_code == 503
    assert storage.put_calls == 2
    assert len(storage.removed) == 1
    assert storage.objects == {}
    assert (
        test_db.query(LoopItemAttachment)
        .filter(LoopItemAttachment.loop_item_id == item.id)
        .count()
        == 0
    )


def test_import_context_attachments_cleanup_failure_preserves_original_error(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    project = _make_project(test_db, test_user, "ATTC")
    item = _make_item(test_db, project, test_user, "Cleanup every object")
    contexts = [
        _make_context(test_db, test_user, name=f"{index}.txt", data=str(index).encode())
        for index in range(3)
    ]
    storage = FailThirdAndFirstCleanupDeliveryStorage()
    monkeypatch.setattr(
        "app.services.loop_items.service.delivery_storage",
        storage,
    )

    with pytest.raises(HTTPException) as exc:
        loop_item_service.import_context_attachments(
            test_db,
            item.id,
            test_user.id,
            [context.id for context in contexts],
        )

    assert exc.value.status_code == 503
    assert exc.value.__cause__ is not None
    assert str(exc.value.__cause__) == "original upload failure"
    assert storage.put_calls == 3
    assert len(storage.cleanup_calls) == 2
    assert "Failed to clean up imported attachment object" in caplog.text
    assert len(storage.objects) == 1


def test_attachment_source_context_identity_is_unique_per_item(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
) -> None:
    project = _make_project(test_db, test_user, "ATTID")
    item = _make_item(test_db, project, test_user, "Concurrent identity")
    context = _make_context(test_db, test_user)
    first = LoopItemAttachment(
        id=str(uuid.uuid4()),
        loop_item_id=item.id,
        display_name="first.txt",
        object_key="first",
        content_type="text/plain",
        size_bytes=1,
        sha256="a" * 64,
        created_by_user_id=test_user.id,
        source_context_id=context.id,
        metadata_json={"source_context_id": context.id},
    )
    duplicate = LoopItemAttachment(
        id=str(uuid.uuid4()),
        loop_item_id=item.id,
        display_name="duplicate.txt",
        object_key="duplicate",
        content_type="text/plain",
        size_bytes=1,
        sha256="b" * 64,
        created_by_user_id=test_user.id,
        source_context_id=context.id,
        metadata_json={"source_context_id": context.id},
    )
    test_db.add(first)
    test_db.commit()
    test_db.add(duplicate)

    with pytest.raises(IntegrityError):
        test_db.commit()

    test_db.rollback()
    assert (
        test_db.query(LoopItemAttachment)
        .filter(
            LoopItemAttachment.loop_item_id == item.id,
            LoopItemAttachment.source_context_id == context.id,
        )
        .count()
        == 1
    )


def test_import_context_attachments_recovers_from_concurrent_unique_conflict(
    test_db: Session,
    test_user: User,
    attachment_storage: FakeDeliveryStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _make_project(test_db, test_user, "ATTR")
    item = _make_item(test_db, project, test_user, "Concurrent retry")
    context = _make_context(test_db, test_user)
    identity_checks = 0

    def source_context_ids(
        _db: Session,
        _item_id: str,
        _context_ids: set[int],
    ) -> set[int]:
        nonlocal identity_checks
        identity_checks += 1
        return set() if identity_checks == 1 else {context.id}

    def concurrent_commit() -> None:
        raise IntegrityError("concurrent attachment import", None, Exception())

    monkeypatch.setattr(
        loop_item_service,
        "_attachment_source_context_ids",
        source_context_ids,
    )
    monkeypatch.setattr(test_db, "commit", concurrent_commit)

    imported = loop_item_service.import_context_attachments(
        test_db,
        item.id,
        test_user.id,
        [context.id],
    )

    assert imported == []
    assert identity_checks == 2
    assert attachment_storage.objects == {}


def test_add_attachment_rolls_back_and_returns_503_when_storage_is_unavailable(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _make_project(test_db, test_user, "ATTU")
    item = _make_item(test_db, project, test_user, "Unavailable storage")
    rollback_calls = 0
    original_rollback = test_db.rollback

    def track_rollback() -> None:
        nonlocal rollback_calls
        rollback_calls += 1
        original_rollback()

    monkeypatch.setattr(
        "app.services.loop_items.service.delivery_storage",
        UnavailableDeliveryStorage(),
    )
    monkeypatch.setattr(test_db, "rollback", track_rollback)

    with pytest.raises(HTTPException) as exc:
        loop_item_service.add_attachment(
            test_db,
            item.id,
            test_user.id,
            "report.txt",
            "text/plain",
            io.BytesIO(b"report"),
        )

    assert exc.value.status_code == 503
    assert exc.value.detail == "Delivery object storage is unavailable"
    assert rollback_calls == 1
    assert (
        test_db.query(LoopItemAttachment)
        .filter(LoopItemAttachment.loop_item_id == item.id)
        .count()
        == 0
    )
