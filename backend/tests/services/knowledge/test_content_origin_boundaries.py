# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Server-side ownership boundaries for generated Code Wiki content."""

import pytest

from app.models.knowledge import ContentOrigin, KnowledgeDocument, KnowledgeFolder
from app.schemas.knowledge import (
    KnowledgeBaseCreate,
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
    KnowledgeFolderCreate,
    KnowledgeFolderUpdate,
)
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.orchestrator import knowledge_orchestrator


def _create_generated_content(test_db, knowledge_base_id: int, user_id: int):
    folder = KnowledgeFolder(
        kind_id=knowledge_base_id,
        parent_id=0,
        name="generated",
        origin=ContentOrigin.GENERATED.value,
    )
    test_db.add(folder)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=knowledge_base_id,
        attachment_id=0,
        name="generated.md",
        file_extension="md",
        file_size=12,
        source_type="text",
        user_id=user_id,
        folder_id=folder.id,
        origin=ContentOrigin.GENERATED.value,
    )
    test_db.add(document)
    test_db.commit()
    test_db.refresh(folder)
    test_db.refresh(document)
    return folder, document


@pytest.mark.unit
def test_generated_content_is_read_only_and_user_content_stays_mutable(
    test_db, test_user
) -> None:
    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="content-origin-boundaries", kb_type="code_wiki"),
    )
    generated_folder, generated_document = _create_generated_content(
        test_db, knowledge_base_id, test_user.id
    )
    user_document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        test_user.id,
        KnowledgeDocumentCreate(
            name="notes.md",
            file_extension="md",
            file_size=10,
            source_type="text",
        ),
    )

    with pytest.raises(ValueError, match="Generated Code Wiki content is read-only"):
        KnowledgeService.update_document(
            test_db,
            generated_document.id,
            test_user.id,
            KnowledgeDocumentUpdate(name="renamed.md"),
        )
    with pytest.raises(ValueError, match="Generated Code Wiki content is read-only"):
        KnowledgeService.update_document_content(
            test_db,
            generated_document.id,
            "manual change",
            test_user.id,
        )
    with pytest.raises(ValueError, match="Generated Code Wiki content is read-only"):
        KnowledgeService.delete_document(test_db, generated_document.id, test_user.id)
    with pytest.raises(ValueError, match="Generated Code Wiki content is read-only"):
        KnowledgeFolderService.update_folder(
            test_db,
            generated_folder.id,
            test_user.id,
            KnowledgeFolderUpdate(name="renamed"),
            knowledge_base_id=knowledge_base_id,
        )
    with pytest.raises(ValueError, match="Generated Code Wiki content is read-only"):
        KnowledgeFolderService.delete_folder(
            test_db,
            generated_folder.id,
            test_user.id,
            knowledge_base_id=knowledge_base_id,
        )
    with pytest.raises(ValueError, match="Generated Code Wiki content is read-only"):
        KnowledgeFolderService.move_document(
            test_db, generated_document.id, 0, test_user.id
        )
    with pytest.raises(ValueError, match="Generated Code Wiki content is read-only"):
        knowledge_orchestrator.reindex_document(
            test_db,
            test_user,
            generated_document.id,
        )

    updated = KnowledgeService.update_document(
        test_db,
        user_document.id,
        test_user.id,
        KnowledgeDocumentUpdate(name="updated-notes.md"),
    )
    assert updated is not None
    assert updated.name == "updated-notes.md"


@pytest.mark.unit
def test_content_origin_partitions_folders_and_rejects_cross_origin_placement(
    test_db, test_user
) -> None:
    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="content-origin-partitions", kb_type="code_wiki"),
    )
    generated_folder, generated_document = _create_generated_content(
        test_db, knowledge_base_id, test_user.id
    )
    user_folder = KnowledgeFolderService.create_folder(
        test_db,
        knowledge_base_id,
        test_user.id,
        KnowledgeFolderCreate(name="notes"),
    )
    user_document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        test_user.id,
        KnowledgeDocumentCreate(
            name="notes.md",
            file_extension="md",
            file_size=10,
            source_type="text",
            folder_id=user_folder.id,
        ),
    )

    generated_documents, generated_total = KnowledgeService.list_documents_paginated(
        test_db,
        knowledge_base_id,
        test_user.id,
        content_origin=ContentOrigin.GENERATED.value,
    )
    user_documents, user_total = KnowledgeService.list_documents_paginated(
        test_db,
        knowledge_base_id,
        test_user.id,
        content_origin=ContentOrigin.USER.value,
    )
    assert generated_total == 1
    assert [document.id for document in generated_documents] == [generated_document.id]
    assert user_total == 1
    assert [document.id for document in user_documents] == [user_document.id]

    generated_tree = KnowledgeFolderService.get_folder_tree(
        test_db,
        knowledge_base_id,
        test_user.id,
        content_origin=ContentOrigin.GENERATED.value,
    )
    user_tree = KnowledgeFolderService.get_folder_tree(
        test_db,
        knowledge_base_id,
        test_user.id,
        content_origin=ContentOrigin.USER.value,
    )
    assert [folder.id for folder in generated_tree] == [generated_folder.id]
    assert [folder.id for folder in user_tree] == [user_folder.id]

    with pytest.raises(ValueError, match="same content origin"):
        KnowledgeService.create_document(
            test_db,
            knowledge_base_id,
            test_user.id,
            KnowledgeDocumentCreate(
                name="wrong-root.md",
                file_extension="md",
                file_size=10,
                source_type="text",
                folder_id=generated_folder.id,
            ),
        )
    with pytest.raises(ValueError, match="same content origin"):
        KnowledgeFolderService.create_folder(
            test_db,
            knowledge_base_id,
            test_user.id,
            KnowledgeFolderCreate(name="wrong-root", parent_id=generated_folder.id),
        )
    with pytest.raises(ValueError, match="same content origin"):
        KnowledgeFolderService.move_document(
            test_db,
            user_document.id,
            generated_folder.id,
            test_user.id,
        )
