# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Install the knowledge-event probe only in explicitly configured E2E processes."""

import json
import os
from pathlib import Path
from typing import Any

_directory = os.environ.get("WEGENT_E2E_EVENT_PROBE_DIR")


class _Receiver:
    def accepts(self, event_type: str) -> bool:
        return event_type.startswith("knowledge.")

    def observation_limit(self, event_type: str) -> int:
        return 128

    def receive(self, event: dict[str, Any]) -> None:
        assert _directory is not None
        root = Path(_directory)
        failure = root / "fail-receiver"
        record = {
            "pid": os.getpid(),
            "event": event,
            "injected_failure": failure.exists(),
        }
        data = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
        if len(data) > 4096:
            raise ValueError("E2E event exceeds the atomic write limit")
        descriptor = os.open(
            root / "events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
        )
        try:
            if os.write(descriptor, data) != len(data):
                raise OSError("partial E2E event write")
        finally:
            os.close(descriptor)
        if failure.exists():
            raise RuntimeError("E2E receiver failure")


def _register() -> None:
    from shared.event_reporting import register_event_receiver

    register_event_receiver(_Receiver())


if _directory:
    Path(_directory).mkdir(parents=True, exist_ok=True)
    _register()
    if hasattr(os, "register_at_fork"):
        os.register_at_fork(after_in_child=_register)
