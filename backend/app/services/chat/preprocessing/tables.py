# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Table context processing module.

Handles table context processing for multiple providers (DingTalk, Feishu, etc.):
- URL parsing for base_id and sheet_id extraction
"""

import logging
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.services.tables import TableURLParser

logger = logging.getLogger(__name__)


def parse_table_url(url: str) -> Optional[Dict[str, str]]:
    """
    Parse table URL to extract provider, base_id and sheet_id.
    Automatically detects the provider from URL.

    Args:
        url: Table URL (DingTalk, Feishu, etc.)

    Returns:
        Dictionary with 'provider', 'baseId' and 'sheetIdOrName', or None if parsing fails
    """
    return TableURLParser.parse_table_url(url)


def detect_provider_from_url(url: str) -> Optional[str]:
    """
    Detect table provider type from URL.

    Args:
        url: Table URL

    Returns:
        Provider type (e.g., "dingtalk", "feishu") or None
    """
    return TableURLParser.detect_provider_from_url(url)


def get_table_context_for_document(
    db: Session,
    document_id: int,
    user_id: int,
) -> Optional[Dict[str, str]]:
    """
    Get table context (base_id, sheet_id_or_name) for a document.

    Args:
        db: Database session
        document_id: Table document ID
        user_id: User ID for permission check

    Returns:
        Dictionary with 'baseId' and 'sheetIdOrName', or None if not found
    """
    from app.services.knowledge import KnowledgeService

    doc = KnowledgeService.get_table_document_by_id(db, document_id, user_id)
    if not doc:
        logger.warning(f"Table document not found: {document_id}")
        return None

    source_config = doc.source_config or {}
    url = source_config.get("url", "")

    if not url:
        logger.warning(f"Table document {document_id} has no URL in source_config")
        return None

    return parse_table_url(url)
