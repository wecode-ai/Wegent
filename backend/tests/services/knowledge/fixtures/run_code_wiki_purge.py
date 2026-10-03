# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve a Code Wiki purge from the Backend database snapshot."""

import asyncio
import json
import sys
from unittest.mock import MagicMock, patch

from knowledge_runtime.services.admin_executor import AdminExecutor
from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from shared.models import RemotePurgeKnowledgeIndexRequest


async def main() -> None:
    db_path, kb_id, user_id = sys.argv[1:]
    engine = create_engine(f"sqlite:///{db_path}")
    loader = RuntimeConfigLoader(session_factory=sessionmaker(bind=engine))
    storage = MagicMock()
    storage.delete_knowledge.return_value = {"status": "deleted"}
    with patch(
        "knowledge_runtime.services.admin_executor.create_storage_backend_from_runtime_config",
        return_value=storage,
    ):
        result = await AdminExecutor(config_loader=loader).purge_knowledge_index(
            RemotePurgeKnowledgeIndexRequest(
                knowledge_base_id=int(kb_id), user_id=int(user_id)
            )
        )
    storage.delete_knowledge.assert_called_once_with(
        knowledge_id=kb_id, user_id=int(user_id)
    )
    print(json.dumps(result))
    engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
