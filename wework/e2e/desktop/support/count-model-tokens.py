# /// script
# requires-python = ">=3.10"
# dependencies = ["tiktoken==0.14.0"]
# ///
"""Count every serialized request field with the pinned E2E budget encoding."""

import json
import sys

import tiktoken

payload = sys.stdin.read()
encoding = tiktoken.get_encoding("o200k_base")
print(
    json.dumps(
        {
            "encoding": "o200k_base",
            "tokens": len(encoding.encode(payload, disallowed_special=())),
        }
    )
)
