# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Read real Milvus data for E2E assertions from the Runtime-owned environment."""

import json
import sys
from typing import Any

from pymilvus import MilvusClient


def main() -> None:
    request: dict[str, Any] = json.load(sys.stdin)
    client = MilvusClient(uri=request.pop("uri"))
    try:
        print(json.dumps(client.query(**request, consistency_level="Strong")))
    finally:
        client.close()


if __name__ == "__main__":
    main()
