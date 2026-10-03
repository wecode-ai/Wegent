# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read Backend's committed indexing result in a separate Runtime process."""

from __future__ import annotations

import asyncio
import json
import sys
from unittest.mock import MagicMock, patch

from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from knowledge_runtime.services.query_executor import QueryExecutor
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from shared.models import RemoteQueryRequest, RetrievalScope


async def main() -> None:
    db_path, kb_id, user_id, document_id = sys.argv[1:]
    engine = create_engine(f"sqlite:///{db_path}")
    loader = RuntimeConfigLoader(session_factory=sessionmaker(bind=engine))
    storage = MagicMock()
    storage.supports_retrieval_scope = True
    storage.retrieve.return_value = {"records": []}
    with (
        patch(
            "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
            return_value=storage,
        ),
        patch(
            "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config",
            return_value=object(),
        ),
    ):
        await QueryExecutor(config_loader=loader).execute(
            RemoteQueryRequest(
                knowledge_base_ids=[int(kb_id)],
                user_id=int(user_id),
                query="微博 大广场模式 2025 有什么优势",
                scope=RetrievalScope(document_ids=[int(document_id)]),
            )
        )
    print(json.dumps(storage.retrieve.call_args.kwargs["retrieval_setting"]))
    engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
