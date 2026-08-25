#!/usr/bin/env python3
"""Issue one stdio RPC request to an Executor process with a hard timeout."""

import json
import os
import queue
import subprocess
import sys
import threading
import time
from typing import Any, TextIO


def parse_response(stdout: str, request_id: str) -> dict[str, Any] | None:
    for line in stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("type") == "response" and message.get("id") == request_id:
            return message
    return None


def enqueue_lines(stream: TextIO, lines: queue.Queue[str | None]) -> None:
    for line in stream:
        lines.put(line)
    lines.put(None)


def collect_lines(stream: TextIO, lines: list[str]) -> None:
    lines.extend(stream)


def stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


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
        bufsize=1,
        env=env,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None

    stdout_lines: queue.Queue[str | None] = queue.Queue()
    stderr_lines: list[str] = []
    stdout_reader = threading.Thread(
        target=enqueue_lines,
        args=(process.stdout, stdout_lines),
        daemon=True,
    )
    stderr_reader = threading.Thread(
        target=collect_lines,
        args=(process.stderr, stderr_lines),
        daemon=True,
    )
    stdout_reader.start()
    stderr_reader.start()

    process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
    process.stdin.flush()

    deadline = time.monotonic() + 20
    response = None
    timed_out = False
    try:
        while response is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                line = stdout_lines.get(timeout=remaining)
            except queue.Empty:
                timed_out = True
                break
            if line is None:
                break
            response = parse_response(line, request_id)
    finally:
        stop_process(process)
        stdout_reader.join(timeout=1)
        stderr_reader.join(timeout=1)

    if timed_out:
        raise SystemExit(f"Executor RPC {method} timed out")

    if response is None:
        detail = "".join(stderr_lines).strip()
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
