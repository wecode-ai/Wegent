# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise Responses cancellation with the Executor E2E job's real local device."""

import json
import os
import time
import unittest
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import httpx
from redis import Redis
from redis.client import PubSub
from sqlalchemy import text

from app.db.session import SessionLocal

SOCKET_CHANNEL = "socketio"
RESPONSES = "/api/v1/responses"
KINDS = "/api/v1/namespaces/default"
TERMINAL_EVENTS = {"response.completed", "response.failed", "response.incomplete"}


def output_text(response: dict) -> str:
    return "".join(
        part["text"]
        for item in response["output"]
        if item["type"] == "message" and item["role"] == "assistant"
        for part in item["content"]
        if part["type"] == "output_text"
    )


class DeviceTraffic:
    def __init__(self, observer: PubSub) -> None:
        self.observer = observer
        self.events: list[tuple[str, dict]] = []

    def read(self, timeout: float) -> None:
        message = self.observer.get_message(timeout=timeout)
        if message and message["type"] in {"message", "pmessage"}:
            self.events.append((message["channel"], json.loads(message["data"])))

    def find(self, matches: Callable[[str, dict], bool], timeout: float) -> dict | None:
        deadline = time.monotonic() + timeout
        while True:
            for channel, event in self.events:
                if matches(channel, event):
                    return event
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self.read(min(0.2, remaining))


def device_event(name: str, task_id: int) -> Callable[[str, dict], bool]:
    def matches(channel: str, envelope: dict) -> bool:
        if channel != SOCKET_CHANNEL or envelope.get("event") != name:
            return False
        payload = envelope["data"]
        if isinstance(payload, list):
            payload = payload[0]
        return str(payload.get("task_id")) == str(task_id)

    return matches


class ResponsesDeviceCancel(unittest.TestCase):
    def setUp(self) -> None:
        self.marker = f"e2e-device-cancel-{uuid.uuid4().hex[:12]}"
        self.device_id = os.getenv(
            "E2E_COMPACTION_DEVICE_ID", "e2e-claudecode-compaction-device"
        )
        self.api = httpx.Client(
            base_url=os.environ["E2E_API_URL"], timeout=30, trust_env=False
        )
        self.model = httpx.Client(
            base_url=f'{os.environ["E2E_MODEL_URL"]}/e2e/{self.marker}',
            timeout=10,
            trust_env=False,
        )
        self.redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
        for client in (self.api, self.model, self.redis):
            self.addCleanup(client.close)
        login = self.checked(
            self.api.post(
                "/api/auth/login",
                json={
                    "user_name": "admin",
                    "password": os.environ["E2E_BOOTSTRAP_ADMIN_PASSWORD"],
                },
            )
        )
        self.api.headers["Authorization"] = f'Bearer {login["access_token"]}'
        self.user_id = self.checked(self.api.get("/api/users/me"))["id"]
        devices = self.checked(self.api.get("/api/devices"))["items"]
        device = next(item for item in devices if item["device_id"] == self.device_id)
        self.assertEqual((device["device_type"], device["status"]), ("local", "online"))
        self.create_fixture()

    def checked(self, response: httpx.Response) -> Any:
        self.assertIn(
            response.status_code, (200, 201), f"{response.request.url}: {response.text}"
        )
        return response.json()

    def delete(self, path: str) -> None:
        response = self.api.delete(path)
        self.assertIn(response.status_code, (200, 204, 404), response.text)

    def create_fixture(self) -> None:
        self.checked(
            self.api.post(
                f"{KINDS}/models",
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Model",
                    "metadata": {"name": self.marker, "namespace": "default"},
                    "spec": {
                        "modelConfig": {
                            "env": {
                                "model": "claude",
                                "model_id": "claude-3-5-sonnet-20241022",
                                "small_model": "claude-3-5-haiku-20241022",
                                "api_key": "mock-api-key",
                                "ANTHROPIC_API_KEY": "mock-api-key",
                                "base_url": f"{self.model.base_url}v1",
                            }
                        }
                    },
                },
            )
        )
        self.addCleanup(self.delete, f"{KINDS}/models/{self.marker}")
        bot = self.checked(
            self.api.post(
                "/api/bots",
                json={
                    "name": self.marker,
                    "namespace": "default",
                    "shell_name": "ClaudeCode",
                    "agent_config": {
                        "bind_model": self.marker,
                        "bind_model_type": "user",
                    },
                    "system_prompt": "Respond directly without tools.",
                    "inherit_base_capabilities": False,
                    "is_active": True,
                },
            )
        )
        self.addCleanup(self.delete, f"{KINDS}/bots/{self.marker}")
        self.checked(
            self.api.post(
                "/api/teams",
                json={
                    "name": self.marker,
                    "namespace": "default",
                    "bind_mode": ["task"],
                    "requires_workspace": False,
                    "is_active": True,
                    "bots": [{"bot_id": bot["id"], "role": "worker"}],
                },
            )
        )
        self.addCleanup(self.delete, f"{KINDS}/teams/{self.marker}")
        self.addCleanup(self.model.delete, "/stream-rules")
        self.addCleanup(self.model.post, "/clear-requests")

    @contextmanager
    def observe(self) -> Iterator[DeviceTraffic]:
        with self.redis.pubsub() as observer:
            observer.psubscribe(SOCKET_CHANNEL, "callback:channel:*")
            for _ in range(2):
                message = observer.get_message(timeout=5)
                self.assertEqual(message and message["type"], "psubscribe", message)
            yield DeviceTraffic(observer)

    @contextmanager
    def stream(
        self, prompt: str, previous: str | None = None
    ) -> Iterator[Iterator[dict]]:
        body: dict[str, Any] = {
            "model": f"default#{self.marker}",
            "input": prompt,
            "stream": True,
        }
        if previous:
            body["previous_response_id"] = previous
        else:
            body["execution"] = {"type": "wegent", "device_id": self.device_id}
        with self.api.stream("POST", RESPONSES, json=body) as response:
            self.assertEqual(
                response.status_code, 200, response.read() if response.is_error else ""
            )
            self.assertIn("text/event-stream", response.headers["content-type"])
            yield (
                json.loads(line[6:])
                for line in response.iter_lines()
                if line.startswith("data: {")
            )

    def created(self, frames: Iterator[dict], previous: str | None = None) -> str:
        first = next(frames)
        self.assertEqual(first["type"], "response.created")
        response_id = first["response"]["id"]
        self.assertRegex(response_id, r"^resp_\d+$")
        if previous:
            self.assertEqual(response_id, previous)
        else:
            self.addCleanup(self.delete, f"/api/tasks/{response_id[5:]}")
        return response_id

    def assistant(self, task_id: int) -> dict:
        task = self.checked(self.api.get(f"/api/tasks/{task_id}"))
        return [turn for turn in task["subtasks"] if turn["role"] == "ASSISTANT"][-1]

    def cancel(self, response_id: str) -> None:
        result = self.checked(self.api.post(f"{RESPONSES}/{response_id}/cancel"))
        self.assertEqual(result["id"], response_id)
        self.assertIn(result["status"], {"in_progress", "cancelled"})

    def assert_finish(
        self, frames: Iterator[dict], response_id: str, reply: str
    ) -> None:
        terminals = [frame for frame in frames if frame["type"] in TERMINAL_EVENTS]
        self.assertEqual(
            [frame["type"] for frame in terminals], ["response.completed"], terminals
        )
        terminal = terminals[0]["response"]
        self.assertEqual(
            (terminal["id"], terminal["status"], output_text(terminal)),
            (response_id, "completed", reply),
        )

    def assert_callback(
        self, traffic: DeviceTraffic, turn_id: int, kind: str, reply: str
    ) -> None:
        callback = traffic.find(
            lambda channel, event: channel == f"callback:channel:{turn_id}"
            and event.get("type") == kind,
            timeout=5,
        )
        self.assertIsNotNone(callback, f"Missing {kind} callback for turn {turn_id}")
        assert callback is not None
        self.assertEqual((callback.get("result") or {}).get("value", ""), reply)

    def assert_retrieved(self, response_id: str, status: str, reply: str) -> None:
        result = self.checked(self.api.get(f"{RESPONSES}/{response_id}"))
        self.assertEqual((result["status"], output_text(result)), (status, reply))

    def test_cancel_before_device_dispatch(self) -> None:
        prompt = f"Must not reach the model for {self.marker}"
        with self.observe() as traffic, SessionLocal() as lock:
            # Hold only the owner-row lock used by real device binding. The
            # Responses stream and Python cancel endpoint can still run.
            self.assertEqual(
                lock.scalar(
                    text("SELECT id FROM users WHERE id = :id FOR UPDATE"),
                    {"id": self.user_id},
                ),
                self.user_id,
            )
            with self.stream(prompt) as frames:
                response_id = self.created(frames)
                task_id = int(response_id[5:])
                turn = self.assistant(task_id)
                self.assertEqual(turn["status"], "PENDING")
                self.cancel(response_id)
                self.assert_callback(traffic, turn["id"], "cancelled", "")
                lock.rollback()
                self.assert_finish(frames, response_id, "")
            self.assertIsNone(
                traffic.find(device_event("task:execute", task_id), timeout=1)
            )
        self.assertEqual(self.assistant(task_id)["status"], "CANCELLED")
        self.assert_retrieved(response_id, "cancelled", "")
        captures = self.checked(self.model.get("/captured-requests"))
        self.assertFalse(
            any(
                item["method"] == "POST" and item["url"].startswith("/v1/")
                for item in captures
            ),
            "The cancelled pending turn reached the model",
        )

    def hold_reply(self, prompt: str, reply: str) -> None:
        self.checked(
            self.model.post(
                "/stream-rules",
                json={
                    "matchText": prompt,
                    "responseContent": reply,
                    "holdDone": True,
                    "chunkDelayMs": 0,
                },
            )
        )

    def wait_for_partial(self, frames: Iterator[dict], reply: str) -> None:
        seen = ""
        for frame in frames:
            self.assertNotIn(frame["type"], TERMINAL_EVENTS, frame)
            if frame["type"] == "response.output_text.delta":
                seen += frame["delta"]
                if seen == reply:
                    return
                self.assertTrue(reply.startswith(seen), seen)
        self.fail(f"Expected partial reply {reply!r}, saw {seen!r}")

    def test_running_cancel_preserves_text_and_late_cancel_leaves_next_turn_running(
        self,
    ) -> None:
        prompt = f"Stream a partial answer for {self.marker}"
        followup = f"Continue the same device conversation with a new full answer for {self.marker}"
        partial = f"保留部分回复 {self.marker}"
        finished = f"新轮次完整回复 {self.marker}"
        self.hold_reply(prompt, partial)
        self.hold_reply(followup, finished)

        with self.observe() as traffic, self.stream(prompt) as frames:
            response_id = self.created(frames)
            task_id = int(response_id[5:])
            self.wait_for_partial(frames, partial)
            old_turn = self.assistant(task_id)
            self.assertEqual(old_turn["status"], "RUNNING")
            self.assertEqual(old_turn["executor_name"], f"device-{self.device_id}")
            self.cancel(response_id)
            packet = traffic.find(device_event("task:cancel", task_id), timeout=5)
            self.assertIsNotNone(
                packet, "HTTP cancel did not publish to the real device"
            )
            assert packet is not None
            payload = (
                packet["data"][0]
                if isinstance(packet["data"], list)
                else packet["data"]
            )
            self.assertEqual(str(payload.get("subtask_id")), str(old_turn["id"]))
            self.assertEqual(packet["room"], f"device:{self.user_id}:{self.device_id}")
            self.assert_callback(traffic, old_turn["id"], "cancelled", partial)
            self.assert_finish(frames, response_id, partial)

        self.assertEqual(self.assistant(task_id)["status"], "CANCELLED")
        self.assert_retrieved(response_id, "cancelled", partial)

        with self.observe() as traffic, self.stream(followup, response_id) as frames:
            self.created(frames, response_id)
            self.wait_for_partial(frames, finished)
            new_turn = self.assistant(task_id)
            self.assertNotEqual(new_turn["id"], old_turn["id"])
            self.assertEqual(new_turn["status"], "RUNNING")
            # Replay the exact old turn payload through the real Socket.IO
            # adapter. A separate sender lets the original server deliver it.
            packet["host_id"] = uuid.uuid4().hex
            self.assertGreaterEqual(
                self.redis.publish(SOCKET_CHANNEL, json.dumps(packet)), 2
            )
            self.assertIsNone(
                traffic.find(
                    lambda channel, event: channel
                    == f'callback:channel:{new_turn["id"]}'
                    and event.get("type") in {"cancelled", "error", "done"},
                    timeout=1,
                ),
                "The new turn settled while its model was still held",
            )
            self.assertEqual(self.assistant(task_id)["status"], "RUNNING")
            released = self.checked(
                self.model.post("/stream-rules/release", json={"matchText": followup})
            )
            self.assertEqual(released["released"], 1)
            self.assert_callback(traffic, new_turn["id"], "done", finished)
            self.assert_finish(frames, response_id, finished)

        self.assertEqual(self.assistant(task_id)["status"], "COMPLETED")
        self.assert_retrieved(response_id, "completed", partial + finished)


if __name__ == "__main__":
    unittest.main(verbosity=2)
