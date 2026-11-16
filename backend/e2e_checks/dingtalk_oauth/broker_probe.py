"""Read-only Redis broker observations; retain only import task identifiers."""

from __future__ import annotations

import base64
import json
import secrets
import threading
from dataclasses import dataclass
from types import TracebackType

from redis import Redis

IMPORT_TASK = "app.tasks.knowledge_tasks.import_external_document"


@dataclass(frozen=True)
class ImportDispatch:
    task_id: str
    document_id: int
    generation: int


def decode_import_dispatch(command: str) -> ImportDispatch | None:
    parts = command.split(" ", 2)
    if len(parts) != 3 or parts[0].upper() not in {"LPUSH", "RPUSH"}:
        return None
    try:
        message = json.loads(parts[2])
    except json.JSONDecodeError:
        return None
    headers = message.get("headers") if isinstance(message, dict) else None
    if not isinstance(headers, dict) or headers.get("task") != IMPORT_TASK:
        return None
    assert message["properties"]["body_encoding"] == "base64"
    _, kwargs, _ = json.loads(base64.b64decode(message["body"]))
    return ImportDispatch(
        task_id=message["headers"]["id"],
        document_id=kwargs["document_id"],
        generation=kwargs["expected_generation"],
    )


class ImportDispatchProbe:
    """Observe real publications, including duplicate messages a worker discards."""

    def __init__(self, broker_url: str) -> None:
        assert broker_url.startswith(("redis://", "rediss://"))
        self.redis = Redis.from_url(broker_url, decode_responses=True)
        self.monitor = self.redis.monitor()
        self.records: list[ImportDispatch] = []
        self.barriers: dict[str, threading.Event] = {}
        self.stopping = threading.Event()
        self.failure: str | None = None
        self.thread = threading.Thread(target=self._read, daemon=True)

    def __enter__(self) -> ImportDispatchProbe:
        self.monitor.__enter__()
        self.thread.start()
        return self

    def _read(self) -> None:
        try:
            while not self.stopping.is_set():
                command = self.monitor.next_command()["command"]
                if command.startswith("PING "):
                    if barrier := self.barriers.get(command.removeprefix("PING ")):
                        barrier.set()
                elif dispatch := decode_import_dispatch(command):
                    self.records.append(dispatch)
        except Exception as exc:
            if not self.stopping.is_set():
                # Monitor traffic may contain credentials; never retain raw errors.
                self.failure = type(exc).__name__

    def drain(self) -> list[ImportDispatch]:
        """A PING barrier proves all preceding publications have been observed."""
        token = secrets.token_hex(16)
        barrier = self.barriers[token] = threading.Event()
        try:
            self.redis.execute_command("PING", token)
            assert barrier.wait(5), "Broker observer did not reach its barrier"
            assert self.failure is None, f"Broker observer failed: {self.failure}"
            return list(self.records)
        finally:
            self.barriers.pop(token, None)

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.stopping.set()
        self.monitor.__exit__(exc_type, exc_value, traceback)
        self.thread.join(5)
        self.redis.close()
        assert not self.thread.is_alive(), "Broker observer did not stop"
        if exc_type is None:
            assert self.failure is None, f"Broker observer failed: {self.failure}"
