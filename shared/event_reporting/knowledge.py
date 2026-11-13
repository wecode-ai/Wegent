# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from .reporter import emit_event


def emit_kb_event(
    event_type: str,
    payload_factory: Callable[[], Mapping[str, Any]],
    *,
    kb_id: int | str | None,
    document_id: int | str | None,
    status: str,
    fact_key_parts: Sequence[object] = (),
    error_code_factory: Callable[[], str | None] | None = None,
    duration_ms_factory: Callable[[], int | None] | None = None,
) -> None:
    parts = tuple(fact_key_parts) or tuple(
        part for part in (kb_id, document_id) if part is not None
    )
    emit_event(
        event_type=event_type,
        payload_factory=payload_factory,
        fact_key_parts=parts,
        kb_id=kb_id,
        document_id=document_id,
        status=status,
        error_code_factory=error_code_factory,
        duration_ms_factory=duration_ms_factory,
    )
