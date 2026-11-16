# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise HTTP readiness on the running Backend and disposable CI Redis."""

import json
import os
import re
import time
from pathlib import Path

import httpx
from redis import Redis

CHANNEL = "socketio"
CLIENT_NAME = "wegent-platform-python-socketio"
READINESS_PATH = "/api/shutdown/status"
READY = {"is_shutting_down": False}
UNAVAILABLE = {"status": "socketio_ack_unavailable", "is_shutting_down": False}


def wait_for_status(
    client: httpx.Client, code: int, timeout: float
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    last = "no response"
    while time.monotonic() < deadline:
        try:
            response = client.get(READINESS_PATH)
        except httpx.TransportError as error:
            last = str(error)
        else:
            if response.status_code == code:
                return response.json()
            last = f"{response.status_code} {response.text[:300]}"
        time.sleep(0.2)
    raise AssertionError(f"Expected HTTP {code} from {READINESS_PATH}, last saw {last}")


def socketio_subscribers(redis: Redis) -> list[str]:
    return [
        client["id"]
        for client in redis.client_list(_type="pubsub")
        if client["name"] == CLIENT_NAME and client["sub"] == "1"
    ]


def socketio_subscriber_id(redis: Redis) -> str:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        subscribers = socketio_subscribers(redis)
        if subscribers:
            assert len(subscribers) == 1, "Expected exactly one Backend worker"
            return subscribers[0]
        time.sleep(0.2)
    raise AssertionError("Socket.IO did not subscribe to Redis during Backend startup")


def observe_probe_publication(redis: Redis) -> None:
    # A pattern observer can still see PUBLISH without counting as a SUBSCRIBE
    # listener for this channel. Only the Backend can complete its ACK callback.
    with redis.pubsub(ignore_subscribe_messages=True) as observer:
        observer.psubscribe(CHANNEL)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            message = observer.get_message(timeout=0.5)
            if message is None:
                continue
            probe = json.loads(message["data"])
            if probe.get("method") == "callback" and str(probe.get("sid")).startswith(
                "wegent-ack-probe:"
            ):
                return
    raise AssertionError("Backend did not publish a probe with its subscription down")


def verify_readiness(client: httpx.Client, redis: Redis, backend_log: Path) -> None:
    assert wait_for_status(client, 200, timeout=180) == READY
    subscriber = socketio_subscriber_id(redis)
    print("HTTP 200 with a Redis subscriber and no Socket.IO clients", flush=True)

    user = redis.acl_whoami()
    acl = redis.acl_getuser(user)
    assert (
        user == "default" and acl["categories"] == ["+@all"] and not acl["commands"]
    ), "Use the disposable Redis service with its default ACL"
    with backend_log.open("rb") as log:
        log.seek(0, os.SEEK_END)
        try:
            redis.execute_command("ACL SETUSER", user, "-subscribe")
            assert redis.client_kill_filter(_id=subscriber) == 1
            assert not socketio_subscribers(redis)
            observe_probe_publication(redis)
            assert wait_for_status(client, 503, timeout=30) == UNAVAILABLE
            assert not socketio_subscribers(redis)
            assert re.search(
                rb"ACK probe unhealthy[^\n]* failures=3\b", log.read()
            ), "Backend did not record a readiness transition at three failures"
            print("HTTP 503 after three consecutive ACK failures", flush=True)
        finally:
            redis.execute_command("ACL SETUSER", user, "+subscribe")

    assert wait_for_status(client, 200, timeout=25) == READY
    socketio_subscriber_id(redis)
    print("HTTP 200 after Redis subscription and ACK delivery recovered", flush=True)


if __name__ == "__main__":
    with (
        httpx.Client(
            base_url=os.environ["E2E_API_URL"], timeout=3, trust_env=False
        ) as http_client,
        Redis.from_url(
            os.environ["E2E_SOCKETIO_REDIS_URL"],
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=3,
        ) as redis_client,
    ):
        verify_readiness(http_client, redis_client, Path(os.environ["E2E_PYTHON_LOG"]))
