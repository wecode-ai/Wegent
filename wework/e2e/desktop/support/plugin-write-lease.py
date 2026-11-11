# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Hold and observe a real lease in the desktop harness's isolated Redis."""

from __future__ import annotations

import json
import os
import sys
import threading
from collections.abc import Callable
from queue import SimpleQueue
from urllib.parse import urlparse

import pymysql
from redis import Redis

_output_lock = threading.Lock()


def emit(event: str) -> None:
    with _output_lock:
        print(json.dumps({"event": event}), flush=True)


def main() -> None:
    url = os.environ["WEWORK_E2E_PLUGIN_REDIS_URL"]
    parsed = urlparse(url)
    if parsed.hostname != "127.0.0.1" or parsed.port != int(
        os.environ["WEWORK_E2E_PLUGIN_REDIS_PORT"]
    ):
        raise ValueError("The lease fixture requires the isolated loopback Redis")
    user_id = int(os.environ["WEWORK_E2E_PLUGIN_USER_ID"])
    if user_id <= 0:
        raise ValueError("The lease fixture requires a positive user ID")
    name = os.environ.get("WEWORK_E2E_PLUGIN_NAME", "")
    key = f"wegent:plugin-write:{user_id}:{name}"
    client = Redis.from_url(url, socket_connect_timeout=1, socket_timeout=2)
    mode = os.environ.get("WEWORK_E2E_PLUGIN_FAULT", "lease")
    if mode in {"user-row", "device-row", "plugin-row"}:
        options = json.loads(os.environ["WEWORK_E2E_PLUGIN_MYSQL"])
        if options["host"] != "127.0.0.1" or not options["database"].startswith(
            "wework_e2e_"
        ):
            raise ValueError("The row lock requires the isolated E2E MySQL")
        with pymysql.connect(**options, user="root", autocommit=False) as db:
            try:
                with db.cursor() as cursor:
                    if mode == "plugin-row":
                        record_id = int(os.environ["WEWORK_E2E_DEVICE_RECORD_ID"])
                        if record_id <= 0:
                            raise ValueError(
                                "The fixture requires a positive record ID"
                            )
                        # Avoid secondary-index next-key locks on other plugins.
                        cursor.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
                        cursor.execute(
                            "UPDATE kinds FORCE INDEX (PRIMARY) SET json=json WHERE id=%s AND user_id=%s "
                            "AND namespace='default' AND kind='InstalledPlugin'",
                            (record_id, user_id),
                        )
                        cursor.execute(
                            "SELECT name FROM kinds WHERE id=%s AND user_id=%s "
                            "AND namespace='default' AND kind='InstalledPlugin'",
                            (record_id, user_id),
                        )
                    elif mode == "device-row":
                        record_id = int(os.environ["WEWORK_E2E_DEVICE_RECORD_ID"])
                        if record_id <= 0:
                            raise ValueError(
                                "The fixture requires a positive record ID"
                            )
                        cursor.execute(
                            "SELECT id FROM kinds WHERE id=%s AND user_id=%s "
                            "AND namespace='default' AND kind='Device' FOR UPDATE",
                            (record_id, user_id),
                        )
                    else:
                        cursor.execute(
                            "SELECT id FROM users WHERE id = %s FOR UPDATE", (user_id,)
                        )
                    row = cursor.fetchone()
                    if row is None:
                        raise ValueError("The fixture row does not exist")
                    if mode == "plugin-row":
                        key = f"wegent:plugin-write:{user_id}:{row[0]}"
                if mode == "plugin-row":

                    def observe_scope():
                        with Redis.from_url(url).monitor() as monitor:
                            emit("ready")
                            for command in monitor.listen():
                                if command["command"].startswith(f"SET {key} "):
                                    emit("contended")

                    threading.Thread(target=observe_scope, daemon=True).start()
                else:
                    emit("ready")
                if sys.stdin.read():
                    raise ValueError("The row lock accepts only stdin closure")
            finally:
                db.rollback()
                client.close()
                emit("released")
        return
    if mode == "redis-unavailable":
        # Deny real SET commands without disrupting reads needed by routing.
        # This Redis is private to this checkpoint, with the default open ACL.
        try:
            client.execute_command("ACL", "SETUSER", "default", "-set")
            emit("ready")
            if sys.stdin.read():
                raise ValueError("The Redis fault accepts only stdin closure")
        finally:
            client.execute_command("ACL", "SETUSER", "default", "+set")
            client.close()
            emit("released")
        return
    if mode != "lease":
        raise ValueError("Unknown coordination fault")
    if not name or name == "undefined":
        raise ValueError("The fixture requires a plugin scope")
    lock = client.lock(key, timeout=30, blocking_timeout=10, thread_local=False)
    if not lock.acquire():
        raise RuntimeError("The fixture could not acquire the plugin write lease")
    stopped = threading.Event()
    release_requested = threading.Event()
    failures: SimpleQueue[Exception] = SimpleQueue()

    def observe() -> None:
        # The holder's own SET has finished before subscribing. Never expose
        # raw MONITOR commands: they can contain credentials and owner tokens.
        with Redis.from_url(url).monitor() as monitor:
            emit("ready")
            for command in monitor.listen():
                if stopped.is_set():
                    return
                if command["command"].startswith(f"SET {key} "):
                    emit("contended")

    def renew() -> None:
        while not stopped.wait(5):
            if not lock.reacquire():
                raise RuntimeError("The fixture lost the plugin write lease")

    def wait_for_release() -> None:
        for _ in sys.stdin:
            raise ValueError("The lease fixture accepts only stdin closure")
        release_requested.set()

    def guarded(operation: Callable[[], None]) -> None:
        try:
            operation()
        except Exception as exc:
            failures.put(exc)
            release_requested.set()

    for operation in (observe, renew, wait_for_release):
        threading.Thread(target=guarded, args=(operation,), daemon=True).start()
    try:
        # Closing stdin always relinquishes the lease, including failed tests.
        release_requested.wait()
        if not failures.empty():
            raise failures.get()
    finally:
        stopped.set()
        lock.release()
        client.close()
        emit("released")


if __name__ == "__main__":
    main()
