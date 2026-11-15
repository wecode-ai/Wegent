# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Document reference encodings accepted by product chunk listings."""

from collections.abc import Iterable


def document_ref_variants(document_ids: Iterable[int]) -> list[str]:
    """Keep current and legacy references within the same document scope."""
    return [
        reference
        for document_id in document_ids
        for reference in (str(document_id), f"doc_{document_id}")
    ]
