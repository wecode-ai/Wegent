# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""One-time retirement support for the removed external Wiki runtime Skill."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
)
from app.services.adapters.skill_kinds import skill_kinds_service
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.skill_binding_service import skill_binding_service

SKILL_NAME = "external-wiki"
SKILL_NAMESPACE = "default"
SKILL_OWNER_ID = 0
LEGACY_LIVE_SOURCE_TYPE = "external_wiki"


@dataclass
class ExternalWikiSkillRetirementReport:
    """Exact references found for the retired system Skill."""

    skill_id: int | None = None
    active: bool = False
    ghost_ids: list[int] = field(default_factory=list)
    binding_ids: list[int] = field(default_factory=list)
    installed_skill_ids: list[int] = field(default_factory=list)
    affected_user_ids: list[int] = field(default_factory=list)
    unexpected_reference_ids: list[int] = field(default_factory=list)
    applied: bool = False


@dataclass
class ExternalWikiLiveDocumentRetirementReport:
    """Exact legacy live-binding rows found for retirement."""

    document_ids: list[int] = field(default_factory=list)
    knowledge_base_ids: list[int] = field(default_factory=list)
    user_ids: list[int] = field(default_factory=list)
    external_identity_document_ids: list[int] = field(default_factory=list)
    attachment_ids: list[int] = field(default_factory=list)
    converted_attachment_ids: list[int] = field(default_factory=list)
    indexed_document_ids: list[int] = field(default_factory=list)
    applied: bool = False


def _spec(row: Kind) -> dict[str, Any]:
    payload = row.json if isinstance(row.json, dict) else {}
    value = payload.get("spec", {})
    return value if isinstance(value, dict) else {}


def _matches_skill_ref(value: Any) -> bool:
    return bool(
        isinstance(value, dict)
        and value.get("kind", "Skill") == "Skill"
        and value.get("name") == SKILL_NAME
        and value.get("namespace", SKILL_NAMESPACE) == SKILL_NAMESPACE
        and value.get("user_id") == SKILL_OWNER_ID
    )


def inspect_external_wiki_skill(db: Session) -> ExternalWikiSkillRetirementReport:
    """Inspect only the exact initialized public external-wiki Skill."""
    skill = (
        db.query(Kind)
        .filter(
            Kind.kind == "Skill",
            Kind.namespace == SKILL_NAMESPACE,
            Kind.name == SKILL_NAME,
            Kind.user_id == SKILL_OWNER_ID,
        )
        .first()
    )
    if skill is None:
        return ExternalWikiSkillRetirementReport()

    # Public Skills may be referenced by Ghosts owned by any user. The regular
    # personal-Skill candidate helper intentionally narrows default namespace
    # rows to their owner, so the retirement audit must inspect every Ghost.
    ghosts = db.query(Kind).filter(Kind.kind == "Ghost", Kind.is_active == True).all()
    ghost_ids = [
        ghost.id
        for ghost in ghosts
        if skill_kinds_service._ghost_references_skill(ghost, skill)
    ]
    bindings = (
        db.query(Kind).filter(Kind.kind == "SkillBinding", Kind.is_active == True).all()
    )
    binding_ids = [
        binding.id
        for binding in bindings
        if skill_binding_service._extract_skill_id(binding) == skill.id
    ]

    installed_rows = (
        db.query(Kind)
        .filter(Kind.kind == "InstalledSkill", Kind.is_active == True)
        .all()
    )
    installed_ids: list[int] = []
    affected_users: set[int] = set()
    unexpected_ids: list[int] = []
    for row in installed_rows:
        spec = _spec(row)
        skill_ref = spec.get("skillRef")
        source = spec.get("source")
        mentions_retired_skill = bool(
            isinstance(source, dict) and source.get("skillKey") == SKILL_NAME
        )
        if _matches_skill_ref(skill_ref):
            installed_ids.append(row.id)
            affected_users.add(row.user_id)
        elif mentions_retired_skill:
            unexpected_ids.append(row.id)

    return ExternalWikiSkillRetirementReport(
        skill_id=skill.id,
        active=bool(skill.is_active),
        ghost_ids=ghost_ids,
        binding_ids=binding_ids,
        installed_skill_ids=installed_ids,
        affected_user_ids=sorted(affected_users),
        unexpected_reference_ids=unexpected_ids,
    )


def retire_external_wiki_skill(
    db: Session,
) -> ExternalWikiSkillRetirementReport:
    """Remove recognized references and soft-delete the exact retired Skill."""
    report = inspect_external_wiki_skill(db)
    if report.skill_id is None or not report.active:
        return report
    if report.unexpected_reference_ids:
        raise RuntimeError(
            "Refusing cleanup because InstalledSkill rows mention external-wiki "
            f"without its exact public Skill ref: {report.unexpected_reference_ids}"
        )

    skill = db.get(Kind, report.skill_id)
    if skill is None:
        return report
    if report.ghost_ids:
        ghosts = db.query(Kind).filter(Kind.id.in_(report.ghost_ids)).all()
        for ghost in ghosts:
            skill_kinds_service._remove_ghost_skill_reference(ghost, skill)
        db.commit()

    referenced_ids = set(report.binding_ids + report.installed_skill_ids)
    if referenced_ids:
        rows = db.query(Kind).filter(Kind.id.in_(referenced_ids)).all()
        for row in rows:
            row.is_active = False
            if row.kind == "InstalledSkill":
                payload = dict(row.json) if isinstance(row.json, dict) else {}
                spec = dict(payload.get("spec") or {})
                spec["enabled"] = False
                spec["installState"] = "uninstalled"
                payload["spec"] = spec
                row.json = payload
                flag_modified(row, "json")
        db.commit()

    skill_kinds_service.delete_skill(
        db,
        skill_id=report.skill_id,
        user_id=SKILL_OWNER_ID,
    )
    report.applied = True
    report.active = False
    return report


def inspect_external_wiki_live_documents(
    db: Session,
) -> ExternalWikiLiveDocumentRetirementReport:
    """Inspect only documents created by the removed live Wiki binding path."""
    documents = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.source_type == LEGACY_LIVE_SOURCE_TYPE)
        .order_by(KnowledgeDocument.id.asc())
        .all()
    )
    return ExternalWikiLiveDocumentRetirementReport(
        document_ids=[document.id for document in documents],
        knowledge_base_ids=sorted({document.kind_id for document in documents}),
        user_ids=sorted({document.user_id for document in documents}),
        external_identity_document_ids=[
            document.id
            for document in documents
            if document.external_source is not None
        ],
        attachment_ids=sorted(
            {document.attachment_id for document in documents if document.attachment_id}
        ),
        converted_attachment_ids=sorted(
            {
                attachment_id
                for document in documents
                if (attachment_id := document.converted_attachment_id)
            }
        ),
        indexed_document_ids=[
            document.id
            for document in documents
            if document.index_status != DocumentIndexStatus.NOT_INDEXED
        ],
    )


def retire_external_wiki_live_documents(
    db: Session,
) -> ExternalWikiLiveDocumentRetirementReport:
    """Delete the exact unindexed, attachment-free legacy live Wiki rows."""
    report = inspect_external_wiki_live_documents(db)
    if not report.document_ids:
        return report

    if report.attachment_ids or report.converted_attachment_ids:
        raise RuntimeError(
            "Refusing cleanup because legacy live Wiki rows unexpectedly own "
            "attachments: "
            f"direct={report.attachment_ids}, converted={report.converted_attachment_ids}"
        )
    if report.indexed_document_ids:
        raise RuntimeError(
            "Refusing cleanup because legacy live Wiki rows unexpectedly have index "
            f"state: {report.indexed_document_ids}"
        )

    documents = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id.in_(report.document_ids))
        .all()
    )
    for document in documents:
        db.delete(document)
    db.flush()

    for knowledge_base_id in report.knowledge_base_ids:
        KnowledgeService._update_document_count_cache(db, knowledge_base_id)
    db.commit()
    report.applied = True
    return report
