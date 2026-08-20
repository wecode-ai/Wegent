#!/usr/bin/env python3
"""Issue one stdio RPC request to an Executor process with a hard timeout."""

import json
import os
import subprocess
import sys
from typing import Any


def parse_response(stdout: str, request_id: str) -> dict[str, Any] | None:
    for line in stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("type") == "response" and message.get("id") == request_id:
            return message
    return None


def main() -> int:
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: executor-rpc-probe.py EXECUTOR DEVICE_ID METHOD PARAMS_JSON"
        )
    executor_bin, device_id, method, params_json = sys.argv[1:]
    request_id = f"acceptance-{os.getpid()}"
    try:
        params = json.loads(params_json)
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid RPC params JSON: {error}") from error

    env = os.environ.copy()
    env["WEGENT_APP_IPC_DEVICE_ID"] = device_id
    env["WEGENT_BACKEND_URL"] = ""
    env["WEGENT_SOCKET_URL"] = ""
    request = {
        "type": "request",
        "id": request_id,
        "method": method,
        "params": params,
    }
    process = subprocess.Popen(
        [executor_bin],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        stdout, stderr = process.communicate(
            json.dumps(request, separators=(",", ":")) + "\n",
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=5)
        raise SystemExit(f"Executor RPC {method} timed out")

    response = parse_response(stdout, request_id)
    if response is None:
        detail = stderr.strip()
        raise SystemExit(
            f"Executor RPC {method} produced no response"
            + (f": {detail}" if detail else "")
        )
    if response.get("ok") is not True:
        error = response.get("error") or {}
        raise SystemExit(
            f"Executor RPC {method} failed: "
            f"{error.get('code', 'unknown')}: "
            f"{error.get('message', 'unknown error')}"
        )
    print(json.dumps(response.get("result"), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
