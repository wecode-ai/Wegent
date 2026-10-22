# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

QUERY_KB = SimpleNamespace(
    id=7,
    user_id=42,
    namespace="default",
    json={
        "spec": {
            "retrievalConfig": {
                "retriever_name": "retriever-a",
                "retriever_namespace": "default",
                "embedding_config": {
                    "model_name": "embed-a",
                    "model_namespace": "default",
                },
            }
        }
    },
)
