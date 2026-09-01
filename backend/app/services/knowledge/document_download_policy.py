# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The core decision for original knowledge-document downloads.

The policy intentionally depends only on open-source models. Internal
deployments can add UI presentation details without becoming an authorization
dependency of the core backend.
"""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.services.knowledge.namespace_utils import get_namespace_level

_NAMESPACE_LEVELS = frozenset({"personal", "group", "organization"})


class DocumentDownloadDisabledError(ValueError):
    """Raised when a KB policy prohibits an original-file export."""

    code = "DOCUMENT_DOWNLOAD_DISABLED"


@dataclass(frozen=True)
class DocumentDownloadDecision:
    """Effective original-file download decision for one knowledge base."""

    original_download_allowed: bool
    protected_by_configuration: bool
    protected_by_namespace: bool


def forced_protected_namespace_levels() -> frozenset[str]:
    """Return configured forced protection levels or fail on invalid settings."""
    raw_levels = settings.KNOWLEDGE_DOCUMENT_FORCE_PROTECT_NAMESPACE_LEVELS.split(",")
    levels = frozenset(level.strip().lower() for level in raw_levels if level.strip())
    if levels == {"none"}:
        return frozenset()

    invalid_levels = levels - _NAMESPACE_LEVELS
    if invalid_levels or "none" in levels:
        invalid = ", ".join(sorted(invalid_levels or {"none"}))
        raise RuntimeError(
            "KNOWLEDGE_DOCUMENT_FORCE_PROTECT_NAMESPACE_LEVELS contains "
            f"unsupported level(s): {invalid}"
        )
    return levels


def resolve_document_download_decision(
    db: Session,
    knowledge_base: Kind,
) -> DocumentDownloadDecision:
    """Resolve the one core policy shared by all original-file exits."""
    spec = knowledge_base.json.get("spec", {}) if knowledge_base.json else {}
    protected_by_configuration = spec.get("allowDocumentDownload", True) is False
    protected_by_namespace = (
        get_namespace_level(db, knowledge_base.namespace)
        in forced_protected_namespace_levels()
    )
    return DocumentDownloadDecision(
        original_download_allowed=not (
            protected_by_configuration or protected_by_namespace
        ),
        protected_by_configuration=protected_by_configuration,
        protected_by_namespace=protected_by_namespace,
    )


def require_document_download_allowed(db: Session, knowledge_base: Kind) -> None:
    """Raise a stable error when the knowledge base is protected."""
    decision = resolve_document_download_decision(db, knowledge_base)
    if not decision.original_download_allowed:
        raise DocumentDownloadDisabledError("Document download is disabled")
