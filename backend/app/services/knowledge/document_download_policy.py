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

from app.models.kind import Kind


class DocumentDownloadDisabledError(ValueError):
    """Raised when a KB policy prohibits an original-file export."""

    code = "DOCUMENT_DOWNLOAD_DISABLED"


@dataclass(frozen=True)
class DocumentDownloadDecision:
    """Effective original-file download decision for one knowledge base."""

    original_download_allowed: bool
    protected_by_configuration: bool


def resolve_document_download_decision(
    db: Session,
    knowledge_base: Kind,
) -> DocumentDownloadDecision:
    """Resolve the one core policy shared by all original-file exits."""
    spec = knowledge_base.json.get("spec", {}) if knowledge_base.json else {}
    protected_by_configuration = spec.get("allowDocumentDownload", True) is False
    return DocumentDownloadDecision(
        original_download_allowed=not protected_by_configuration,
        protected_by_configuration=protected_by_configuration,
    )


def require_document_download_allowed(db: Session, knowledge_base: Kind) -> None:
    """Raise a stable error when the knowledge base is protected."""
    decision = resolve_document_download_decision(db, knowledge_base)
    if not decision.original_download_allowed:
        raise DocumentDownloadDisabledError("Document download is disabled")
