# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from ...reporter import emit_event


def error_code_for(error: BaseException) -> str:
    """Copy an explicit code, otherwise use the exception type; never walk causes."""
    try:
        code = getattr(error, "code", None)
        return (
            code if isinstance(code, str) and len(code) <= 80 else type(error).__name__
        )
    except Exception:
        return "unknown_error"


def loaded_scalar(source: object, name: str) -> Any:
    """Read an already loaded field without invoking ORM descriptors or properties."""
    try:
        values = source if type(source) is dict else vars(source)
        return values.get(name)
    except Exception:
        return None


def observe(event_type: str, fields_factory: Callable[[], dict[str, Any]]) -> None:
    """Run the fixed-field snapshot synchronously, only after SDK admission."""
    emit_event(event_type=event_type, fields_factory=fields_factory)


def emit_fact(
    event_type: str,
    *,
    kb_id: int | str | None,
    document_id: int | str | None,
    status: str,
    data: Mapping[str, Any],
    fact_key_parts: Sequence[object] = (),
    error_code: str | None = None,
    duration_ms: int | None = None,
) -> None:
    emit_event(
        event_type=event_type,
        payload_factory=lambda: data,
        kb_id=kb_id,
        document_id=document_id,
        status=status,
        fact_key_parts=fact_key_parts,
        error_code_factory=lambda: error_code,
        duration_ms_factory=lambda: duration_ms,
    )
