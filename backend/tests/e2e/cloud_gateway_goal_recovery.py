# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise the real Executor and Backend with the existing E2E model service."""

import json
import os
import re
import select
import subprocess
import tempfile
import time
import unittest
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
from jose import jwt

from app.core.config import settings

OWNER_PATH = "/api/devices/runtime-owner"
GATEWAY_PATH = "/api/runtime-work/llm-responses-proxy"
MODELS_PATH = "/api/v1/namespaces/default/models"


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def checked(response: httpx.Response) -> Any:
    response.raise_for_status()
    return response.json() if response.content else None


def wait_for(label: str, observe: Callable[[], Any], timeout: float = 20) -> Any:
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        result = observe()
        if result:
            return result
        time.sleep(0.2)
    raise AssertionError(f"Timed out waiting for {label}")


class Executor:
    def __init__(self, process: subprocess.Popen, log: Path) -> None:
        self.process = process
        self.log = log
        self.buffer = bytearray()

    def rpc(self, method: str, **params: Any) -> dict:
        request_id = uuid.uuid4().hex
        data = dict(type="request", id=request_id, method=method, params=params)
        self.process.stdin.write(json.dumps(data).encode() + b"\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 25
        while True:
            while b"\n" in self.buffer:
                line, _, rest = self.buffer.partition(b"\n")
                self.buffer = bytearray(rest)
                message = json.loads(line)
                if message.get("id") == request_id:
                    if not message.get("ok"):
                        raise AssertionError(f"{method}: {message.get('error', {})}")
                    return message["result"]
            remaining = deadline - time.monotonic()
            if (
                remaining <= 0
                or not select.select([self.process.stdout], [], [], remaining)[0]
            ):
                raise AssertionError(f"Timed out waiting for Executor RPC {method}")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise AssertionError(f"Executor stopped during {method}")
            self.buffer.extend(chunk)

    def proxy_url(self) -> str:
        match = re.search(r"listening on (127\.0\.0\.1:\d+)", self.log.read_text())
        if not match:
            raise AssertionError("Missing Executor model proxy address")
        return f"http://{match[1]}/v1/codex-router/responses"


class CloudGatewayGoalRecovery(unittest.TestCase):
    def login(self, name: str, password: str) -> tuple[str, int]:
        token = checked(
            self.api.post(
                "/api/auth/login",
                json={
                    "user_name": name,
                    "password": password,
                },
            )
        )["access_token"]
        owner = checked(self.api.get("/api/users/me", headers=bearer(token)))["id"]
        return token, owner

    def device_key(self, user_token: str) -> tuple[str, int]:
        key = checked(
            self.api.post(
                "/api/api-keys",
                headers=bearer(user_token),
                json={"name": self.marker},
            )
        )
        self.addCleanup(
            self.api.delete, f"/api/api-keys/{key['id']}", headers=bearer(user_token)
        )
        self.addCleanup(
            self.api.delete, f"/api/devices/{self.marker}", headers=bearer(user_token)
        )
        return key["key"], key["id"]

    def setUp(self) -> None:
        self.marker = "gateway-goal-" + uuid.uuid4().hex[:12]
        self.base = os.environ["E2E_API_URL"].rstrip("/")
        self.api = httpx.Client(base_url=self.base, timeout=5, trust_env=False)
        self.model = httpx.Client(
            base_url=f"{os.environ['E2E_MODEL_URL']}/e2e/{self.marker}",
            timeout=5,
            trust_env=False,
        )
        self.addCleanup(self.api.close)
        self.addCleanup(self.model.close)
        home = tempfile.TemporaryDirectory(prefix="gateway-goal-")
        self.addCleanup(home.cleanup)
        self.home = Path(home.name)
        self.workspace = self.home / "work"
        self.workspace.mkdir()
        self.owner_token, self.owner = self.login(
            "admin", os.environ["E2E_BOOTSTRAP_ADMIN_PASSWORD"]
        )
        password = uuid.uuid4().hex
        other = checked(
            self.api.post(
                "/api/admin/users",
                headers=bearer(self.owner_token),
                json={"user_name": self.marker, "password": password},
            )
        )
        self.addCleanup(
            self.api.delete,
            f"/api/admin/users/{other['id']}",
            headers=bearer(self.owner_token),
        )
        self.other_token, self.other_owner = self.login(self.marker, password)
        self.assertNotEqual(self.owner, self.other_owner)
        self.key, self.key_id = self.device_key(self.owner_token)
        self.new_key, _ = self.device_key(self.owner_token)
        self.other_key, _ = self.device_key(self.other_token)
        self.create_model()

    def create_model(self) -> None:
        checked(
            self.api.post(
                MODELS_PATH,
                headers=bearer(self.owner_token),
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Model",
                    "metadata": {"name": self.marker, "namespace": "default"},
                    "spec": {
                        "protocol": "openai-responses",
                        "apiFormat": "responses",
                        "modelConfig": {
                            "env": {
                                "model": "openai",
                                "model_id": self.marker,
                                "api_key": "mock-model-key",
                                "base_url": f"{self.model.base_url}v1",
                            }
                        },
                    },
                },
            )
        )
        self.addCleanup(
            self.api.delete,
            f"{MODELS_PATH}/{self.marker}",
            headers=bearer(self.owner_token),
        )
        self.addCleanup(self.model.delete, "/stream-rules")
        self.addCleanup(self.model.post, "/clear-requests")

    @contextmanager
    def executor(self) -> Iterator[Executor]:
        log_path = self.home / "executor.log"
        env = {
            **os.environ,
            "HOME": str(self.home),
            "WEGENT_EXECUTOR_HOME": str(self.home / "executor"),
            "WEGENT_CODEX_HOME": str(self.home / "codex"),
            "CODEX_HOME": str(self.home / "codex"),
            "LOCAL_WORKSPACE_ROOT": str(self.workspace),
            "EXECUTOR_MODE": "local",
            "DEVICE_ID": self.marker,
            "WEGENT_APP_IPC_DEVICE_ID": self.marker,
            "BIND_SHELL": "claudecode",
        }
        for name in (
            "WEGENT_APP_IPC_ENDPOINT",
            "WEGENT_BACKEND_URL",
            "WEGENT_AUTH_TOKEN",
        ):
            env.pop(name, None)
        with log_path.open("w") as log:
            with subprocess.Popen(
                [os.environ["E2E_EXECUTOR_BINARY"]],
                cwd=self.workspace,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=log,
            ) as process:
                try:
                    executor = Executor(process, log_path)
                    self.connect(executor, self.key, self.owner)
                    yield executor
                except Exception:
                    print(
                        re.sub(
                            r"\b(?:wg-[a-zA-Z0-9_-]+|eyJ[a-zA-Z0-9_.-]+)\b",
                            "[credential]",
                            log_path.read_text()[-6000:],
                        )
                    )
                    raise
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)

    def connect(
        self, executor: Executor, key: str, owner: int, base: str | None = None
    ) -> None:
        base = base or self.base
        self.assertEqual(
            checked(self.api.get(base + OWNER_PATH, headers=bearer(key)))["id"], owner
        )
        result = executor.rpc(
            "executor.backend.configure",
            backend_url=base,
            auth_token=key,
            authenticated_user_id=owner,
            device_type="remote",
        )
        self.assertTrue(result["connected"])
        wait_for(
            "device registration",
            lambda: executor.rpc("executor.backend.status")["connected"],
        )

    def create_task(self, executor: Executor, launch: str) -> dict:
        config = {
            "model": "openai",
            "model_id": self.marker,
            "api_format": "responses",
            "protocol": "openai-responses",
            "codex_catalog_model_id": "wework-gpt-5.6-sol",
            "base_url": self.base + GATEWAY_PATH,
            "api_key": launch,
            "wework_model_kind": "cloud",
            "default_headers": {
                "X-Wegent-Model-Type": "user",
                "X-Wegent-Model-Namespace": "default",
                "X-Wegent-Model-User-Id": str(self.owner),
            },
            "runtime_config": {"codex": {"use_user_config": False, "configured": True}},
        }
        started = executor.rpc(
            "runtime.tasks.create",
            taskId=self.marker,
            title=self.marker,
            runtime="codex",
            workspacePath=str(self.workspace),
            message=self.marker,
            executionRequest={
                "task_id": self.marker,
                "subtask_id": self.marker + "-initial",
                "user_id": self.owner,
                "prompt": self.marker,
                "new_session": True,
                "bot": [{"shell_type": "Codex"}],
                "model_config": config,
            },
        )
        self.assertTrue(started["accepted"], started.get("error"))
        return {
            "deviceId": started["deviceId"],
            "taskId": self.marker,
            "workspacePath": str(self.workspace),
        }

    def captured(self, marker: str | None = None) -> list:
        requests = checked(self.model.get("/captured-requests"))
        return [
            entry
            for entry in requests
            if marker is None or marker in json.dumps(entry["body"])
        ]

    def proxy(self, executor: Executor, thread_id: str, marker: str) -> httpx.Response:
        return self.api.post(
            executor.proxy_url(),
            headers=bearer("wework-local-router"),
            json={
                "model": self.marker,
                "input": marker,
                "stream": False,
                "client_metadata": {"thread_id": thread_id},
            },
        )

    def assert_rejected(self, executor: Executor, thread_id: str, marker: str) -> None:
        upstream_responses = executor.log.read_text().count(
            "local model proxy upstream headers received"
        )
        response = self.proxy(executor, thread_id, marker)
        self.assertEqual(response.status_code, 401)
        self.assertIn("connected account", response.text)
        self.assertEqual(
            executor.log.read_text().count(
                "local model proxy upstream headers received"
            ),
            upstream_responses,
            "The rejected request reached the model gateway",
        )
        self.assertEqual(self.captured(marker), [])

    def test_expired_goal_recovery_and_live_device_key_changes(self) -> None:
        with self.executor() as executor:
            # The real Backend validates the launch credential. Keep the same claims
            # as a compiled cloud model and shorten only the fixture's lifetime.
            launch = jwt.encode(
                {"sub": "admin", "user_id": self.owner, "exp": int(time.time()) + 15},
                settings.SECRET_KEY,
                algorithm=settings.ALGORITHM,
            )
            self.assertEqual(
                checked(self.api.get("/api/users/me", headers=bearer(launch)))["id"],
                self.owner,
            )
            address = self.create_task(executor, launch)
            wait_for("initial model request", lambda: self.captured(self.marker))
            original = wait_for(
                "initial task completion",
                lambda: (
                    task
                    if (
                        task := executor.rpc(
                            "runtime.tasks.get",
                            taskId=self.marker,
                        )["task"]
                    ).get("status")
                    == "done"
                    else None
                ),
                30,
            )
        wait_for(
            "real Backend rejecting expired launch JWT",
            lambda: self.api.get("/api/users/me", headers=bearer(launch)).status_code
            == 401,
        )
        checked(
            self.model.post(
                "/stream-rules",
                json={
                    "matchText": self.marker,
                    "responseContent": "Goal resumed",
                    "holdResponse": True,
                },
            )
        )

        # Recreate the Executor against the same private task store. The original
        # launch JWT is unavailable in the persisted model action profile.
        with self.executor() as restored:
            resumed = restored.rpc(
                "runtime.tasks.goal.set",
                address=address,
                objective=self.marker,
                status="active",
            )
            self.assertTrue(resumed["accepted"], resumed.get("error"))
            self.assertEqual(resumed["goal"]["status"], "active")
            wait_for(
                "resumed Goal reaching the real model gateway",
                lambda: any(
                    rule["pendingResponses"] > 0
                    for rule in checked(self.model.get("/stream-rules"))
                ),
            )
            thread_id = original["threadId"]
            self.connect(restored, self.new_key, self.owner)
            checked(
                self.api.delete(
                    f"/api/api-keys/{self.key_id}", headers=bearer(self.owner_token)
                )
            )
            self.assertEqual(
                self.api.get(OWNER_PATH, headers=bearer(self.key)).status_code, 401
            )
            rotated = "rotated-" + self.marker.removeprefix("gateway-goal-")
            self.assertEqual(self.proxy(restored, thread_id, rotated).status_code, 200)
            self.assertEqual(len(self.captured(rotated)), 1)

            self.connect(restored, self.other_key, self.other_owner)
            self.assert_rejected(restored, thread_id, "other-owner-" + rotated)

            # Exercise a different Backend origin with the original owner while
            # sharing the CI Backend service, database and model runner.
            alternate = (
                self.base.replace("127.0.0.1", "localhost")
                if "127.0.0.1" in self.base
                else self.base.replace("localhost", "127.0.0.1")
            )
            self.assertNotEqual(alternate, self.base)
            self.connect(restored, self.new_key, self.owner, alternate)
            self.assert_rejected(restored, thread_id, "other-backend-" + rotated)
            checked(
                self.model.post(
                    "/stream-rules/release", json={"matchText": self.marker}
                )
            )


if __name__ == "__main__":
    unittest.main()
