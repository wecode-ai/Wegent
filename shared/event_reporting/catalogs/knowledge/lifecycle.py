# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from ._common import emit_fact


def emit_knowledge_base_created(
    *, kb_id: int, kb_type: str, source_type: str = "native"
) -> None:
    emit_fact(
        "knowledge.kb.created",
        kb_id=kb_id,
        document_id=None,
        status="success",
        data={"kb_type": kb_type, "source_type": source_type},
        fact_key_parts=(kb_id,),
    )


def emit_knowledge_base_deleted(*, kb_id: int, delete_mode: str) -> None:
    emit_fact(
        "knowledge.kb.deleted",
        kb_id=kb_id,
        document_id=None,
        status="success",
        data={"delete_mode": delete_mode},
        fact_key_parts=(kb_id,),
    )


def emit_document_created(
    *,
    kb_id: int,
    document_id: int,
    source_type: str | None,
    trigger: str,
    file_extension: str | None,
    content_bytes: int | None,
) -> None:
    emit_fact(
        "knowledge.document.created",
        kb_id=kb_id,
        document_id=document_id,
        status="success",
        data={
            "source_type": source_type,
            "trigger": trigger,
            "file_extension": file_extension,
            "content_bytes": content_bytes,
        },
        fact_key_parts=(kb_id, document_id),
    )


def emit_document_deleted(
    *,
    kb_id: int,
    document_id: int,
    source_type: str | None,
    trigger: str,
    had_active_index: bool | None,
) -> None:
    emit_fact(
        "knowledge.document.deleted",
        kb_id=kb_id,
        document_id=document_id,
        status="success",
        data={
            "source_type": source_type,
            "trigger": trigger,
            "had_active_index": had_active_index,
        },
        fact_key_parts=(kb_id, document_id),
    )
