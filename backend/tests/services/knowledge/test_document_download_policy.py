# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for original knowledge-document download protection."""

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate, KnowledgeBaseUpdate
from app.services.knowledge.document_download_policy import (
    DocumentDownloadDisabledError,
    is_original_download_allowed,
    require_document_download_allowed,
)
from app.services.knowledge.knowledge_service import KnowledgeService


def _knowledge_base(*, namespace: str, allow_document_download: bool | None) -> Kind:
    now = datetime.utcnow()
    return Kind(
        user_id=1,
        kind="KnowledgeBase",
        name=f"kb-{namespace}",
        namespace=namespace,
        json={
            "spec": (
                {"allowDocumentDownload": allow_document_download}
                if allow_document_download is not None
                else {}
            )
        },
        is_active=True,
        created_at=now,
        updated_at=now,
    )


def test_configuration_disables_original_download_for_personal_kb(
    test_db: Session,
) -> None:
    knowledge_base = _knowledge_base(namespace="default", allow_document_download=False)

    assert is_original_download_allowed(test_db, knowledge_base) is False
    with pytest.raises(DocumentDownloadDisabledError):
        require_document_download_allowed(test_db, knowledge_base)


def test_missing_configuration_allows_original_download_in_open_source(
    test_db: Session,
) -> None:
    knowledge_base = _knowledge_base(namespace="company", allow_document_download=None)

    assert is_original_download_allowed(test_db, knowledge_base) is True
    require_document_download_allowed(test_db, knowledge_base)


def _namespace(
    test_db: Session,
    *,
    name: str,
    level: str,
    owner_user_id: int,
) -> Namespace:
    namespace = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner_user_id,
        level=level,
        is_active=True,
    )
    test_db.add(namespace)
    test_db.flush()
    return namespace


def _created_spec_download_flag(test_db: Session, kind_id: int) -> bool | None:
    kind = test_db.query(Kind).filter(Kind.id == kind_id).first()
    assert kind is not None
    return kind.json.get("spec", {}).get("allowDocumentDownload")


def test_create_without_download_setting_allows_every_namespace(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
) -> None:
    _namespace(
        test_db, name="acme-org", level="organization", owner_user_id=test_admin_user.id
    )

    personal_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="personal-kb"),
    )
    assert _created_spec_download_flag(test_db, personal_id) is None

    organization_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_admin_user.id,
        KnowledgeBaseCreate(name="org-kb", namespace="acme-org"),
    )
    assert _created_spec_download_flag(test_db, organization_id) is None

    personal = test_db.query(Kind).filter(Kind.id == personal_id).one()
    organization = test_db.query(Kind).filter(Kind.id == organization_id).one()
    assert is_original_download_allowed(test_db, personal) is True
    assert is_original_download_allowed(test_db, organization) is True


def test_create_explicit_download_value_wins_over_namespace_default(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
) -> None:
    _namespace(
        test_db, name="acme-org", level="organization", owner_user_id=test_admin_user.id
    )

    allowed_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_admin_user.id,
        KnowledgeBaseCreate(
            name="org-kb-explicit", namespace="acme-org", allow_document_download=True
        ),
    )
    assert _created_spec_download_flag(test_db, allowed_id) is True

    protected_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="personal-kb-explicit", allow_document_download=False),
    )
    assert _created_spec_download_flag(test_db, protected_id) is False


def test_update_clearing_download_override_returns_to_allowed_default(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
) -> None:
    _namespace(
        test_db, name="acme-org", level="organization", owner_user_id=test_admin_user.id
    )

    personal_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="personal-kb", allow_document_download=False),
    )
    KnowledgeService.update_knowledge_base(
        test_db,
        personal_id,
        test_user.id,
        KnowledgeBaseUpdate(allow_document_download=None),
    )
    assert _created_spec_download_flag(test_db, personal_id) is None

    organization_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_admin_user.id,
        KnowledgeBaseCreate(
            name="org-kb",
            namespace="acme-org",
            allow_document_download=False,
        ),
    )
    KnowledgeService.update_knowledge_base(
        test_db,
        organization_id,
        test_admin_user.id,
        KnowledgeBaseUpdate(allow_document_download=None),
    )
    assert _created_spec_download_flag(test_db, organization_id) is None
