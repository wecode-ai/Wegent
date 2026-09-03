# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The core decision for original knowledge-document downloads.

The policy intentionally depends only on open-source models. Internal
deployments can add UI presentation details without becoming an authorization
dependency of the core backend.
"""

from sqlalchemy.orm import Session

from app.models.kind import Kind


class DocumentDownloadDisabledError(ValueError):
    """Raised when a KB policy prohibits an original-file export."""

    code = "DOCUMENT_DOWNLOAD_DISABLED"


def is_original_download_allowed(db: Session, knowledge_base: Kind) -> bool:
    """Resolve the one core policy shared by all original-file exits.

    A missing, null, or true ``allowDocumentDownload`` all mean "allowed";
    only an explicit false protects the knowledge base.
    """
    spec = knowledge_base.json.get("spec", {}) if knowledge_base.json else {}
    return spec.get("allowDocumentDownload", True) is not False


def require_document_download_allowed(db: Session, knowledge_base: Kind) -> None:
    """Raise a stable error when the knowledge base is protected."""
    if not is_original_download_allowed(db, knowledge_base):
        raise DocumentDownloadDisabledError("Document download is disabled")
