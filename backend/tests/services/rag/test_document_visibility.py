# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Document visibility at Backend retrieval read boundaries."""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    DocumentStatus,
    KnowledgeDocument,
    KnowledgeFolder,
)
from app.models.subtask_context import ContextType, SubtaskContext
from app.schemas.knowledge import KnowledgeDocumentUpdate
from app.services.knowledge.document_read_service import DocumentReadService
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.rag.direct_injection import (
    estimate_total_tokens_for_knowledge_bases,
    get_original_documents_from_knowledge_base,
)


@pytest.fixture
def visibility_db(test_db: Session) -> Session:
    test_db.add(
        Kind(
            id=1,
            user_id=42,
            kind="KnowledgeBase",
            name="visibility-kb",
            namespace="default",
            json={"spec": {}},
            is_active=True,
        )
    )
    test_db.add_all(
        [
            KnowledgeFolder(id=1, kind_id=1, parent_id=0, name="parent"),
            KnowledgeFolder(id=2, kind_id=1, parent_id=1, name="child"),
            KnowledgeFolder(id=3, kind_id=1, parent_id=0, name="empty"),
        ]
    )
    for document_id, status, active, kb_id in (
        (10, DocumentStatus.ENABLED, True, 1),
        (11, DocumentStatus.DISABLED, True, 1),
        (12, DocumentStatus.ENABLED, False, 1),
        (20, DocumentStatus.ENABLED, True, 2),
    ):
        test_db.add(
            SubtaskContext(
                id=document_id,
                user_id=42,
                context_type=ContextType.ATTACHMENT.value,
                name=f"doc-{document_id}",
                extracted_text=f"body-{document_id}",
                text_length=100,
            )
        )
        test_db.add(
            KnowledgeDocument(
                id=document_id,
                kind_id=kb_id,
                attachment_id=document_id,
                name=f"doc-{document_id}",
                file_extension="txt",
                user_id=42,
                status=status,
                is_active=active,
                index_status=(
                    DocumentIndexStatus.SUCCESS
                    if active
                    else DocumentIndexStatus.NOT_INDEXED
                ),
                chunks={"indexed": "retained"},
                folder_id={11: 1, 12: 2}.get(document_id, 0),
            )
        )
    test_db.flush()
    return test_db


@pytest.mark.asyncio
@pytest.mark.parametrize("document_ids", [None, [10, 11, 12, 20]])
async def test_direct_injection_excludes_disabled_and_unindexed_documents(
    visibility_db: Session, document_ids: list[int] | None
) -> None:
    records = await get_original_documents_from_knowledge_base(
        [1], visibility_db, document_ids=document_ids
    )

    assert records is not None
    assert [record["metadata"]["document_id"] for record in records] == [10]
    assert records[0]["content"] == "body-10"


@pytest.mark.parametrize(
    "document_ids, expected", [(None, 150), ([10, 11, 12, 20], 150), ([11], 0), ([], 0)]
)
def test_estimation_only_counts_enabled_indexed_documents(
    visibility_db: Session, document_ids: list[int] | None, expected: int
) -> None:
    assert (
        estimate_total_tokens_for_knowledge_bases(
            visibility_db, [1], document_ids=document_ids
        )
        == expected
    )


def test_document_read_rejects_disabled_and_unindexed_documents(
    visibility_db: Session,
) -> None:
    results = DocumentReadService().read_documents(
        visibility_db, document_ids=[10, 11, 12], knowledge_base_ids=[1]
    )

    assert results[0]["content"] == "body-10"
    assert [result.get("error_code") for result in results] == [
        None,
        "DOCUMENT_NOT_FOUND",
        "DOCUMENT_NOT_FOUND",
    ]


def test_kb_size_only_counts_enabled_indexed_documents(
    visibility_db: Session,
) -> None:
    stats = KnowledgeService.get_active_document_text_length_stats(visibility_db, 1)

    assert stats.text_length_total == 100
    assert stats.active_document_count == 1


def test_management_preview_reads_stored_bodies_without_search_visibility(
    visibility_db: Session,
) -> None:
    results = DocumentReadService().read_documents(
        visibility_db,
        document_ids=[10, 11, 12],
        knowledge_base_ids=[1],
        searchable_only=False,
    )

    assert [result["content"] for result in results] == [
        "body-10",
        "body-11",
        "body-12",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "folder_ids, include_subfolders, expected",
    [([0], True, [10]), ([1], False, []), ([1], True, []), ([3], True, [])],
)
async def test_folder_scope_filters_disabled_documents_without_expanding_to_kb(
    visibility_db: Session,
    folder_ids: list[int],
    include_subfolders: bool,
    expected: list[int],
) -> None:
    document_ids = KnowledgeFolderService.resolve_document_ids_for_scope(
        visibility_db,
        1,
        42,
        folder_ids=folder_ids,
        include_subfolders=include_subfolders,
    )
    records = await get_original_documents_from_knowledge_base(
        [1], visibility_db, document_ids=document_ids
    )

    assert records is not None
    assert [record["metadata"]["document_id"] for record in records] == expected
    assert estimate_total_tokens_for_knowledge_bases(
        visibility_db, [1], document_ids
    ) == (150 if expected else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("document_ids", [None, [10, 11]])
async def test_disable_all_and_reenable_preserves_indexed_content(
    visibility_db: Session, document_ids: list[int] | None
) -> None:
    for disabled_ids, expected in (([11], [10]), ([10, 11], []), ([], [10, 11])):
        for document_id in (10, 11):
            updated = KnowledgeService.update_document(
                visibility_db,
                document_id,
                42,
                KnowledgeDocumentUpdate(
                    status=(
                        DocumentStatus.DISABLED
                        if document_id in disabled_ids
                        else DocumentStatus.ENABLED
                    )
                ),
            )
            assert updated.is_active is True
            assert updated.index_status == DocumentIndexStatus.SUCCESS
            assert updated.chunks == {"indexed": "retained"}

        records = await get_original_documents_from_knowledge_base(
            [1], visibility_db, document_ids
        )

        assert records is not None
        assert [record["metadata"]["document_id"] for record in records] == expected
        assert estimate_total_tokens_for_knowledge_bases(
            visibility_db, [1], document_ids
        ) == 150 * len(expected)
        reads = DocumentReadService().read_documents(
            visibility_db, document_ids=[10, 11], knowledge_base_ids=[1]
        )
        assert [record["id"] for record in reads if "content" in record] == expected
