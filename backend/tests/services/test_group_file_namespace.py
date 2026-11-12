"""Group files use distinct namespaces before any object-storage operation."""

from io import BytesIO
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProjectFile, CollaborationChatGroup
from app.models.resource_member import ResourceMember
from app.services.cloud_files.service import CloudFileService


def group(db, user, index=1):
    container = CollaborationChatGroup(
        project_key=f"FILES{index}", name=f"Group {index}", created_by_user_id=user.id
    )
    db.add(container)
    db.flush()
    container.storage_prefix = f"groups/{container.id}"
    db.add(
        ResourceMember(
            resource_type="CollaborationChatGroup",
            resource_id=int(container.id),
            entity_type="user",
            entity_id=str(user.id),
            user_id=user.id,
            role="Owner",
            status="approved",
        )
    )
    db.commit()
    return container


def test_same_path_in_two_groups_never_overwrites_another_group(test_db, test_user):
    first, second = group(test_db, test_user), group(test_db, test_user, 2)
    blobs = {}
    storage = MagicMock()
    storage.put_stream.side_effect = lambda key, source, *_: blobs.update(
        {key: source.read()}
    )
    storage.get_bytes.side_effect = lambda key, *_: blobs[key]
    service = CloudFileService(storage)
    files = [
        service.upload(
            test_db,
            container.id,
            test_user.id,
            "notes.txt",
            "text/plain",
            BytesIO(content),
        )
        for container, content in [(first, b"first group"), (second, b"second group")]
    ]
    assert files[0].object_key != files[1].object_key
    assert service.read_content(test_db, files[0].id, test_user.id)[0] == b"first group"
    assert (
        service.read_content(test_db, files[1].id, test_user.id)[0] == b"second group"
    )


@pytest.mark.parametrize(
    "operation", ["read", "url", "move", "delete", "recursive-delete", "recursive-move"]
)
def test_wrong_namespace_is_rejected_before_storage_calls(
    test_db, test_user, operation
):
    container = group(test_db, test_user)
    folder = CloudProjectFile(
        cloud_project_id=container.id,
        path="folder",
        name="folder",
        kind="folder",
        created_by_user_id=test_user.id,
    )
    unsafe = CloudProjectFile(
        cloud_project_id=container.id,
        path="folder/notes.txt",
        name="notes.txt",
        kind="file",
        object_key="None/shared/notes.txt",
        created_by_user_id=test_user.id,
    )
    test_db.add_all([folder, unsafe])
    test_db.commit()
    storage = MagicMock()
    service = CloudFileService(storage)
    operations = {
        "read": lambda: service.read_content(test_db, unsafe.id, test_user.id),
        "url": lambda: service.access_url(test_db, unsafe.id, test_user.id),
        "move": lambda: service.move(
            test_db, unsafe.id, test_user.id, "other.txt", unsafe.version
        ),
        "delete": lambda: service.delete(test_db, unsafe.id, test_user.id),
        "recursive-delete": lambda: service.delete(
            test_db, folder.id, test_user.id, recursive=True
        ),
        "recursive-move": lambda: service.move(
            test_db, folder.id, test_user.id, "other", folder.version
        ),
    }
    with pytest.raises(HTTPException) as rejected:
        operations[operation]()
    assert rejected.value.status_code == 409
    assert storage.mock_calls == []
    assert test_db.get(CloudProjectFile, unsafe.id) is not None


def test_uninitialized_namespace_rejects_upload_without_storage(test_db, test_user):
    container = group(test_db, test_user)
    container.storage_prefix = None
    test_db.commit()
    storage = MagicMock()
    with pytest.raises(HTTPException) as rejected:
        CloudFileService(storage).upload(
            test_db,
            container.id,
            test_user.id,
            "notes.txt",
            "text/plain",
            BytesIO(b"private"),
        )
    assert rejected.value.status_code == 409
    assert storage.mock_calls == []
