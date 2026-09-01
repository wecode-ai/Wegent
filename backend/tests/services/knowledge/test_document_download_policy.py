# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for original knowledge-document download protection."""

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.schemas.namespace import GroupLevel
from app.services.knowledge.document_download_policy import (
    resolve_document_download_decision,
)


def _knowledge_base(*, namespace: str, allow_document_download: bool) -> Kind:
    now = datetime.utcnow()
    return Kind(
        user_id=1,
        kind="KnowledgeBase",
        name=f"kb-{namespace}",
        namespace=namespace,
        json={"spec": {"allowDocumentDownload": allow_document_download}},
        is_active=True,
        created_at=now,
        updated_at=now,
    )


def test_configuration_disables_original_download_for_personal_kb(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "KNOWLEDGE_DOCUMENT_FORCE_PROTECT_NAMESPACE_LEVELS", "none"
    )
    knowledge_base = _knowledge_base(namespace="default", allow_document_download=False)

    decision = resolve_document_download_decision(test_db, knowledge_base)

    assert decision.original_download_allowed is False
    assert decision.protected_by_configuration is True
    assert decision.protected_by_namespace is False


def test_organization_namespace_is_protected_by_default(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "KNOWLEDGE_DOCUMENT_FORCE_PROTECT_NAMESPACE_LEVELS", "organization"
    )
    namespace = Namespace(
        name="company",
        display_name="Company",
        owner_user_id=1,
        level=GroupLevel.organization.value,
        is_active=True,
    )
    test_db.add(namespace)
    test_db.flush()
    knowledge_base = _knowledge_base(
        namespace=namespace.name, allow_document_download=True
    )

    decision = resolve_document_download_decision(test_db, knowledge_base)

    assert decision.original_download_allowed is False
    assert decision.protected_by_configuration is False
    assert decision.protected_by_namespace is True
