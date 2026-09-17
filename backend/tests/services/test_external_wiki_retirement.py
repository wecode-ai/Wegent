# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.services.external_wiki_retirement import (
    inspect_external_wiki_live_documents,
    retire_external_wiki_live_documents,
)


def _kind(test_db, *, user_id: int, kind: str, name: str, json: dict) -> Kind:
    row = Kind(
        user_id=user_id,
        kind=kind,
        name=name,
        namespace="default",
        json=json,
        is_active=True,
    )
    test_db.add(row)
    test_db.commit()
    test_db.refresh(row)
    return row


def _document(
    test_db,
    *,
    knowledge_base_id: int,
    user_id: int,
    source_type: str,
    resource_id: str,
) -> KnowledgeDocument:
    document = KnowledgeDocument(
        kind_id=knowledge_base_id,
        attachment_id=0,
        name=f"{resource_id}.md",
        file_extension="md",
        file_size=0,
        user_id=user_id,
        is_active=True,
        index_status=DocumentIndexStatus.NOT_INDEXED,
        source_type=source_type,
        source_config={"wiki": {"page_id": resource_id}},
    )
    test_db.add(document)
    test_db.flush()
    document.external_source = KnowledgeDocumentExternalSource(
        document_id=document.id,
        kind_id=knowledge_base_id,
        external_provider="wiki",
        external_resource_id=resource_id,
    )
    test_db.commit()
    test_db.refresh(document)
    return document


def test_live_document_retirement_deletes_only_legacy_rows(test_db, test_user):
    knowledge_base = _kind(
        test_db,
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="wiki",
        json={"spec": {"document_count": 2}},
    )
    legacy = _document(
        test_db,
        knowledge_base_id=knowledge_base.id,
        user_id=test_user.id,
        source_type="external_wiki",
        resource_id="legacy-page",
    )
    synchronized = _document(
        test_db,
        knowledge_base_id=knowledge_base.id,
        user_id=test_user.id,
        source_type="external",
        resource_id="synchronized-page",
    )

    dry_run = inspect_external_wiki_live_documents(test_db)

    assert dry_run.document_ids == [legacy.id]
    assert dry_run.external_identity_document_ids == [legacy.id]
    assert dry_run.attachment_ids == []
    assert dry_run.indexed_document_ids == []
    assert test_db.get(KnowledgeDocument, legacy.id) is not None

    applied = retire_external_wiki_live_documents(test_db)

    assert applied.applied is True
    assert test_db.get(KnowledgeDocument, legacy.id) is None
    assert test_db.get(KnowledgeDocumentExternalSource, legacy.id) is None
    assert test_db.get(KnowledgeDocument, synchronized.id) is not None
    test_db.refresh(knowledge_base)
    assert knowledge_base.json["spec"]["document_count"] == 1

    repeated = retire_external_wiki_live_documents(test_db)
    assert repeated.applied is False


def test_live_document_retirement_refuses_indexed_rows(test_db, test_user):
    knowledge_base = _kind(
        test_db,
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="wiki",
        json={"spec": {"document_count": 1}},
    )
    legacy = _document(
        test_db,
        knowledge_base_id=knowledge_base.id,
        user_id=test_user.id,
        source_type="external_wiki",
        resource_id="indexed-legacy-page",
    )
    legacy.index_status = DocumentIndexStatus.SUCCESS
    test_db.commit()

    with pytest.raises(RuntimeError, match=str(legacy.id)):
        retire_external_wiki_live_documents(test_db)

    assert test_db.get(KnowledgeDocument, legacy.id) is not None
