# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ._common import emit_fact


def emit_index_event(
    event_type: str,
    *,
    kb_id: int | str,
    document_id: int | str | None,
    status: str,
    operation_id: object,
    data: Mapping[str, Any],
    error_code: str | None = None,
    duration_ms: int | None = None,
) -> None:
    emit_fact(
        event_type,
        kb_id=kb_id,
        document_id=document_id,
        status=status,
        data=data,
        fact_key_parts=(kb_id, document_id, operation_id),
        error_code=error_code,
        duration_ms=duration_ms,
    )
