# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio

from sqlalchemy.orm import Session

from app.services.rag.runtime_resolver import RagRuntimeResolver
from app.services.rag.runtime_specs import ConnectionTestRuntimeSpec
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config


async def test_connection_local(
    spec: ConnectionTestRuntimeSpec,
    *,
    db: Session | None = None,
) -> dict:
    if db is None:
        raise ValueError("db is required for test_connection_local")

    resolver = RagRuntimeResolver()
    kb = resolver._get_knowledge_base_record(
        db=db,
        knowledge_base_id=spec.knowledge_base_id,
    )
    if kb is None:
        return {
            "success": False,
            "message": f"Knowledge base {spec.knowledge_base_id} not found",
        }

    retrieval_config = (kb.json or {}).get("spec", {}).get("retrievalConfig") or {}
    retriever_name = retrieval_config.get("retriever_name")
    retriever_namespace = retrieval_config.get("retriever_namespace", "default")
    if not retriever_name:
        return {
            "success": False,
            "message": f"Knowledge base {spec.knowledge_base_id} has incomplete retrieval config (missing retriever_name)",
        }

    resolved_retriever_config = resolver._build_resolved_retriever_config(
        db=db,
        user_id=spec.user_id,
        name=retriever_name,
        namespace=retriever_namespace,
    )
    storage_backend = create_storage_backend_from_runtime_config(
        resolved_retriever_config
    )
    success = await asyncio.to_thread(storage_backend.test_connection)
    return {
        "success": success,
        "message": "Connection successful" if success else "Connection failed",
    }
