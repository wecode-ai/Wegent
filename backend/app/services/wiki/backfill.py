# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backfill real metadata onto existing external-wiki document rows.

Rows created before the metadata fix carry file_size=0 and a bind-instant
updated_at; the wiki source time only survives inside
source_config.wiki.page_updated_at. Real sizes need the page body, so the
backfill reads each bound page through the adder's delegated connection and
re-applies the same metadata the bind path writes (design §4.3).

``backfill_wiki_documents`` is a pure planning+apply pipeline over
(documents, fetcher) so it is testable without a live wiki; the script in
``scripts/backfill_external_wiki.py`` wires it to the database and the
connector registry.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from app.services.wiki.connector import WikiApiError
from app.services.wiki.service import (
    WIKI_SOURCE_CONFIG_KEY,
    apply_wiki_page_metadata,
    wiki_document_path,
)

logger = logging.getLogger(__name__)

# Per-row failure record: ids and error codes only, never page content or
# credentials (they end up in operator logs).
_MAX_FAILURES_LOGGED = 50

PageFetcher = Callable[[Any], Awaitable[Any]]


@dataclass
class WikiBackfillResult:
    """Outcome of one backfill pass."""

    updated_ids: list[int] = field(default_factory=list)
    failed_ids: list[int] = field(default_factory=list)
    failures: list[dict[str, Any]] = field(default_factory=list)


async def backfill_wiki_documents(
    documents: list[Any], fetch_page: PageFetcher
) -> WikiBackfillResult:
    """Refresh wiki metadata on each document row; failures do not stop the pass.

    ``fetch_page`` receives the document row and returns its WikiPage (or
    None when the page no longer exists); it raises WikiApiError on upstream
    failures. Rows are mutated in place — the caller owns persistence.
    """
    result = WikiBackfillResult()
    for document in documents:
        path = wiki_document_path(document)
        if not path:
            _record_failure(result, document, "wiki_document_invalid")
            continue
        try:
            page = await fetch_page(document)
        except WikiApiError as exc:
            _record_failure(result, document, exc.error_code)
            continue
        except Exception:
            # Unexpected connector failures must not abort the whole pass.
            _record_failure(result, document, "wiki_fetch_failed")
            logger.exception(
                "[wiki-backfill] Unexpected error refreshing document %s",
                document.id,
            )
            continue
        if page is None:
            _record_failure(result, document, "wiki_page_missing")
            continue
        apply_wiki_page_metadata(document, page)
        _set_wiki_config(document, "page_updated_at", page.updated_at or "")
        _set_wiki_config(document, "metadata_refreshed_at", _refresh_stamp())
        result.updated_ids.append(document.id)
    return result


def _record_failure(result: WikiBackfillResult, document: Any, error_code: str) -> None:
    result.failed_ids.append(document.id)
    if len(result.failures) < _MAX_FAILURES_LOGGED:
        adder = _wiki_config(document).get("bound_by_user_id")
        result.failures.append(
            {
                "document_id": document.id,
                "error_code": error_code,
                "added_by_user_id": adder,
            }
        )


def _wiki_config(document: Any) -> dict[str, Any]:
    source_config = getattr(document, "source_config", None)
    if not isinstance(source_config, dict):
        return {}
    config = source_config.get(WIKI_SOURCE_CONFIG_KEY)
    return config if isinstance(config, dict) else {}


def _set_wiki_config(document: Any, key: str, value: Any) -> None:
    """Merge one key into source_config.wiki, preserving the rest."""
    source_config = dict(getattr(document, "source_config", None) or {})
    wiki = dict(source_config.get(WIKI_SOURCE_CONFIG_KEY) or {})
    wiki[key] = value
    source_config[WIKI_SOURCE_CONFIG_KEY] = wiki
    document.source_config = source_config


def _refresh_stamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
