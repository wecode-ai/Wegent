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
    inspect_external_wiki_skill,
    retire_external_wiki_live_documents,
    retire_external_wiki_skill,
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


def _create_target(test_db) -> Kind:
    return _kind(
        test_db,
        user_id=0,
        kind="Skill",
        name="external-wiki",
        json={"spec": {"description": "retired"}},
    )


def test_retirement_removes_exact_references_and_is_idempotent(test_db, test_user):
    skill = _create_target(test_db)
    other = _kind(
        test_db,
        user_id=test_user.id,
        kind="Skill",
        name="external-wiki",
        json={"spec": {"description": "personal"}},
    )
    ghost = _kind(
        test_db,
        user_id=test_user.id,
        kind="Ghost",
        name="wiki-agent",
        json={
            "spec": {
                "skills": [skill.name],
                "skill_refs": {skill.name: {"skill_id": skill.id}},
            }
        },
    )
    binding = _kind(
        test_db,
        user_id=test_user.id,
        kind="SkillBinding",
        name=f"user-{test_user.id}-skill-{skill.id}",
        json={"spec": {"skillRef": {"skillId": skill.id}}},
    )
    installed = _kind(
        test_db,
        user_id=test_user.id,
        kind="InstalledSkill",
        name="legacy-external-wiki",
        json={
            "spec": {
                "source": {"type": "personal", "skillKey": skill.name},
                "skillRef": {
                    "kind": "Skill",
                    "name": skill.name,
                    "namespace": skill.namespace,
                    "user_id": skill.user_id,
                },
                "enabled": True,
                "installState": "installed",
            }
        },
    )

    dry_run = inspect_external_wiki_skill(test_db)
    assert dry_run.ghost_ids == [ghost.id]
    assert dry_run.binding_ids == [binding.id]
    assert dry_run.installed_skill_ids == [installed.id]
    assert test_db.get(Kind, skill.id).is_active is True

    applied = retire_external_wiki_skill(test_db)
    assert applied.applied is True
    assert test_db.get(Kind, skill.id).is_active is False
    assert test_db.get(Kind, other.id).is_active is True
    assert test_db.get(Kind, binding.id).is_active is False
    assert test_db.get(Kind, installed.id).is_active is False
    assert test_db.get(Kind, installed.id).json["spec"]["installState"] == "uninstalled"
    assert test_db.get(Kind, ghost.id).json["spec"]["skills"] == []

    repeated = retire_external_wiki_skill(test_db)
    assert repeated.applied is False


def test_retirement_refuses_ambiguous_installed_skill(test_db, test_user):
    skill = _create_target(test_db)
    ambiguous = _kind(
        test_db,
        user_id=test_user.id,
        kind="InstalledSkill",
        name="ambiguous-external-wiki",
        json={
            "spec": {
                "source": {"type": "system", "skillKey": skill.name},
                "skillRef": {
                    "kind": "Skill",
                    "name": skill.name,
                    "namespace": "other",
                    "user_id": 0,
                },
            }
        },
    )

    with pytest.raises(RuntimeError, match=str(ambiguous.id)):
        retire_external_wiki_skill(test_db)

    assert test_db.get(Kind, skill.id).is_active is True
    assert test_db.get(Kind, ambiguous.id).is_active is True


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
