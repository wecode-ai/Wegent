# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The protocol suite observes actual import dispatches without retaining secrets."""

import base64
import json
from queue import Queue
from types import SimpleNamespace

import pytest
from redis.client import Monitor as RedisMonitor

from e2e_checks.dingtalk_oauth.broker_probe import (
    ImportDispatchProbe,
    decode_import_dispatch,
)


def import_message() -> str:
    return json.dumps(
        {
            "headers": {
                "task": "app.tasks.knowledge_tasks.import_external_document",
                "id": "task-1",
            },
            "properties": {"body_encoding": "base64"},
            "body": base64.b64encode(
                json.dumps(
                    [[], {"document_id": 17, "expected_generation": 3}, {}]
                ).encode()
            ).decode(),
        }
    )


def test_broker_observation_decodes_only_external_import_tasks() -> None:
    envelope = json.loads(import_message())

    dispatch = decode_import_dispatch("LPUSH wegent_online " + json.dumps(envelope))

    assert dispatch is not None
    assert dispatch.task_id == "task-1"
    assert dispatch.document_id == 17
    assert dispatch.generation == 3
    assert decode_import_dispatch("GET private-credential-key") is None
    envelope["headers"]["task"] = "app.tasks.knowledge_tasks.index_document"
    assert decode_import_dispatch("LPUSH wegent_online " + json.dumps(envelope)) is None


def test_redis_monitor_unescaping_preserves_celery_envelope() -> None:
    arguments = ["LPUSH", "wegent_online", import_message()]
    wire = "1000.0 [0 127.0.0.1:1234] " + " ".join(
        json.dumps(argument) for argument in arguments
    )
    connection = SimpleNamespace(
        read_response=lambda: wire.encode(),
        encoder=SimpleNamespace(decode=lambda value, force: value.decode()),
    )
    monitor = RedisMonitor(SimpleNamespace(get_connection=lambda: connection))

    dispatch = decode_import_dispatch(monitor.next_command()["command"])

    assert dispatch is not None
    assert (dispatch.document_id, dispatch.generation) == (17, 3)


def test_ping_barrier_drains_dispatches_and_closes_the_observer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: Queue[str] = Queue()
    closed: list[bool] = []

    class Monitor:
        def __enter__(self):
            return self

        def next_command(self):
            return {"command": commands.get(timeout=1)}

        def __exit__(self, *args):
            commands.put("PING stop")

    client = SimpleNamespace(
        monitor=Monitor,
        execute_command=lambda *args: commands.put(" ".join(args)),
        close=lambda: closed.append(True),
    )
    monkeypatch.setattr(
        "e2e_checks.dingtalk_oauth.broker_probe.Redis.from_url",
        lambda *args, **kwargs: client,
    )

    with ImportDispatchProbe("redis://fixture") as probe:
        commands.put("GET private-credential-key")
        commands.put("LPUSH wegent_online " + import_message())
        records = probe.drain()
        assert [(row.document_id, row.generation) for row in records] == [(17, 3)]
        assert "private-credential-key" not in repr(records)
        commands.put("LPUSH wegent_online " + import_message())
        assert len(probe.drain()) == 2

    assert closed == [True]
    assert not probe.thread.is_alive()
