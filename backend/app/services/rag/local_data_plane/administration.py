# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio

from sqlalchemy.orm import Session

from app.services.rag.runtime_specs import ConnectionTestRuntimeSpec
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config


async def test_connection_local(
    spec: ConnectionTestRuntimeSpec,
    *,
    db: Session | None = None,
) -> dict:
    del db
    storage_backend = create_storage_backend_from_runtime_config(spec.retriever_config)
    success = await asyncio.to_thread(storage_backend.test_connection)
    return {
        "success": success,
        "message": "Connection successful" if success else "Connection failed",
    }
