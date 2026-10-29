# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Execute real subscriptions through supported shells and verify notifications.

Only the model provider and outward DingTalk OpenAPI are replaced by local
recording servers. Subscription creation, Celery execution, model-driven task
completion, persistence, directive parsing, DingTalk delivery and webhooks all
run through product services and the running CI infrastructure.
"""

from __future__ import annotations

import json
import os
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.subscription_follow import SubscriptionFollow
from app.models.user import User
from shared.utils.crypto import encrypt_sensitive_data

COMMAND = "uv run --no-sync python tests/e2e/subscription_execution_notification_directives.py"


class _DingTalkStub(BaseHTTPRequestHandler):
    """Record DingTalk calls; optionally fail the group create request."""

    requests: list[dict[str, Any]] = []
    fail_group = False

    def log_message(self, *_args) -> None:
        return

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length)
        body = json.loads(raw or b"{}")
        type(self).requests.append({"path": self.path, "payload": body})
        if self.path == "/v1.0/oauth2/accessToken":
            result = {"accessToken": "e2e-token", "expireIn": 7200}
        elif self.path == "/v1.0/card/instances/createAndDeliver":
            group = body["openSpaceId"].startswith("dtv1.card//IM_GROUP.")
            if group and type(self).fail_group:
                type(self).requests[-1]["forced_failure"] = True
                self.send_response(500)
                self.end_headers()
                return
            result = {"success": True, "result": {"outTrackId": body["outTrackId"]}}
        else:
            result = {"success": True}
        payload = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_PUT(self) -> None:
        self.send_response(200)
        self.end_headers()


def _cards(entries: list[dict], space: str) -> list[dict]:
    return [
        entry["payload"]
        for entry in entries
        if entry["path"] == "/v1.0/card/instances/createAndDeliver"
        and not entry.get("forced_failure")
        and entry["payload"]["openSpaceId"].startswith(f"dtv1.card//{space}.")
    ]


class SubscriptionExecutionNotificationDirectives(unittest.TestCase):
    """Real subscription execution through model and notification services."""

    @classmethod
    def setUpClass(cls) -> None:
        base_url = os.environ["E2E_API_URL"].rstrip("/")
        cls.client = httpx.Client(base_url=base_url, timeout=30, trust_env=False)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _DingTalkStub)
        cls.stub_url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        import threading

        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        response = cls.client.post(
            "/api/auth/admin-password/setup",
            json={"password": os.environ["E2E_BOOTSTRAP_ADMIN_PASSWORD"]},
        )
        if response.status_code not in (200, 201, 409):
            raise AssertionError(response.text)
        login = cls.client.post(
            "/api/auth/login",
            json={
                "user_name": "admin",
                "password": os.environ["E2E_BOOTSTRAP_ADMIN_PASSWORD"],
            },
        )
        login.raise_for_status()
        cls.client.headers["Authorization"] = f"Bearer {login.json()['access_token']}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        self.suffix = uuid.uuid4().hex
        _DingTalkStub.requests = []
        _DingTalkStub.fail_group = False
        self.created: list[tuple[str, Any]] = []
        self.addCleanup(self._cleanup)

    def _api(self, method: str, path: str, expected=(200,), **kwargs) -> Any:
        response = self.client.request(method, path, **kwargs)
        if response.status_code not in expected:
            self.fail(f"{method} {path}: {response.status_code} {response.text}")
        return response

    def _create_shell_resources(self, shell_type: str) -> dict[str, Any]:
        suffix = self.suffix
        model_name = f"e2e-model-{suffix}"
        bot_name = f"e2e-bot-{suffix}"
        team_name = f"e2e-team-{suffix}"
        model = {
            "kind": "Model",
            "metadata": {"name": model_name, "namespace": "default"},
            "spec": {
                "modelConfig": {
                    "env": {
                        "model": "openai" if shell_type == "Chat" else "claude",
                        "model_id": "mock-e2e-model",
                        "small_model": "mock-e2e-small-model",
                        "api_key": "mock-api-key",
                        "base_url": f"http://localhost:9999/v1",
                    }
                }
            },
        }
        self._api(
            "POST",
            "/api/v1/namespaces/default/models",
            json=model,
            expected=(200, 201),
        )
        self.created.append(("model", model_name))

        if shell_type != "Chat":
            shell_name = f"e2e-shell-{suffix}"
            image = os.environ.get(
                "E2E_EXECUTOR_IMAGE", "wegent/e2e-claudecode-executor:latest"
            )
            self._api(
                "POST",
                "/api/shells",
                json={
                    "name": shell_name,
                    "displayName": "E2E ClaudeCode",
                    "baseShellRef": "ClaudeCode",
                    "baseImage": image,
                },
                expected=(200, 201),
            )
            self.created.append(("shell", shell_name))
        else:
            shell_name = "Chat"

        bot = self._api(
            "POST",
            "/api/bots",
            json={
                "name": bot_name,
                "shell_name": shell_name,
                "namespace": "default",
                "agent_config": {"bind_model": model_name, "bind_model_type": "user"},
                "system_prompt": "Answer the user directly without tools.",
                "is_active": True,
            },
            expected=(201,),
        ).json()
        self.created.append(("bot", bot["id"]))
        team = self._api(
            "POST",
            "/api/teams",
            json={
                "name": team_name,
                "namespace": "default",
                "description": "E2E subscription directives",
                "bots": [{"bot_id": bot["id"], "bot_prompt": "", "role": "worker"}],
                "bind_mode": ["chat"],
                "requires_workspace": False,
                "is_active": True,
            },
            expected=(201,),
        ).json()
        self.created.append(("team", team_name))
        return team

    def _create_messager_channel(self) -> int:
        suffix = self.suffix
        channel = Kind(
            user_id=0,
            kind="Messager",
            name=f"e2e-channel-{suffix}",
            namespace="default",
            is_active=True,
            json={
                "kind": "Messager",
                "metadata": {"name": f"e2e-channel-{suffix}", "namespace": "default"},
                "spec": {
                    "channelType": "dingtalk",
                    "isEnabled": False,
                    "config": {
                        "client_id": "e2e-client",
                        "client_secret": encrypt_sensitive_data("e2e-secret"),
                        "card_template_id": "e2e-template",
                        "api_base_url": self.stub_url,
                    },
                },
            },
        )
        with SessionLocal() as db:
            db.add(channel)
            db.commit()
            channel_id = channel.id
        self.created.append(("messager", channel_id))
        return channel.id

    def _create_subscription(
        self, prompt: str, team: dict[str, Any], channel_id: int
    ) -> int:
        suffix = self.suffix
        execution_target = {"type": "managed", "device_id": None}
        if self.shell_type != "Chat":
            execution_target = {
                "type": "local",
                "device_id": os.environ.get("E2E_DEVICE_ID", "e2e-platform-device-1"),
            }
        self._api(
            "POST",
            "/api/subscriptions",
            json={
                "display_name": f"E2E directives {suffix}",
                "task_type": "collection",
                "trigger_type": "cron",
                "trigger_config": {
                    "expression": "0 0 * * *",
                    "timezone": "UTC",
                },
                "team_id": team["id"],
                "model_ref": {"name": f"e2e-model-{suffix}", "namespace": "default"},
                "force_override_bot_model": True,
                "prompt_template": prompt,
                "enabled": True,
                "execution_target": execution_target,
                "notification_webhooks": [
                    {
                        "type": "custom",
                        "url": f"{self.stub_url}/webhook",
                        "enabled": True,
                    }
                ],
            },
            expected=(201,),
        )
        response = self.client.get("/api/subscriptions")
        response.raise_for_status()
        subscription = next(
            item
            for item in response.json()["items"]
            if item["display_name"] == f"E2E directives {suffix}"
        )
        subscription_id = subscription["id"]
        self.created.append(("subscription", subscription_id))
        self._api(
            "PUT",
            f"/api/subscriptions/{subscription_id}/developer/notification-settings",
            json={
                "notification_level": "notify",
                "notification_channel_ids": [channel_id],
                "channel_binding_configs": [
                    {
                        "channel_id": channel_id,
                        "bind_private": True,
                        "bind_group": True,
                        "group_conversation_id": f"cid-e2e-{suffix}",
                        "group_name": "E2E group",
                    }
                ],
            },
        )
        with SessionLocal() as db:
            user = db.query(User).filter(User.user_name == "admin").first()
            user.preferences = json.dumps(
                {
                    "im_channels": {
                        str(channel_id): {
                            "channel_type": "dingtalk",
                            "sender_id": "900101",
                            "sender_staff_id": "900101",
                        }
                    }
                }
            )
            db.commit()
        return subscription_id

    def _configure_model_response(self, prompt: str) -> None:
        response = "测试，现在时间：12:00:00"
        if "【静默】" in prompt and "【@列表" in prompt:
            response += "\n【静默】【@列表：900101】"
        elif "【静默】" in prompt:
            response += "\n【静默】"
        elif "【@列表" in prompt:
            response += "\n【@列表：900101】"
        self.client.post(
            "http://localhost:9999/stream-rules",
            json={
                "matchText": "测试，现在时间",
                "responseContent": response,
                "chunkDelayMs": 0,
                "doneDelayMs": 0,
            },
        )

    def _cleanup(self) -> None:
        for kind, identifier in reversed(self.created):
            try:
                if kind == "subscription":
                    with SessionLocal() as db:
                        db.query(SubscriptionFollow).filter(
                            SubscriptionFollow.subscription_id == identifier
                        ).delete(synchronize_session=False)
                        db.query(BackgroundExecution).filter(
                            BackgroundExecution.subscription_id == identifier
                        ).delete(synchronize_session=False)
                        db.query(Kind).filter(Kind.id == identifier).delete(
                            synchronize_session=False
                        )
                        db.commit()
                elif kind == "messager":
                    with SessionLocal() as db:
                        db.query(Kind).filter(Kind.id == identifier).delete()
                        db.commit()
                else:
                    path = {
                        "model": f"/api/v1/namespaces/default/models/{identifier}",
                        "bot": f"/api/bots/{identifier}",
                        "shell": f"/api/shells/{identifier}",
                        "team": f"/api/v1/namespaces/default/teams/{identifier}",
                    }[kind]
                    self.client.delete(path)
            except Exception:
                pass

    def _wait_execution(self, subscription_id: int, execution_id: int) -> dict:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            with SessionLocal() as db:
                execution = db.get(BackgroundExecution, execution_id)
                state = {
                    "status": execution.status,
                    "summary": execution.result_summary,
                    "error": execution.error_message,
                }
            state["requests"] = _DingTalkStub.requests
            if state["status"] in (
                "COMPLETED",
                "FAILED",
                "CANCELLED",
                "COMPLETED_SILENT",
            ):
                return state
            time.sleep(0.25)
        self.fail(f"execution {execution_id} did not finish: {state}")

    def _wait_private_card(self, execution: dict) -> dict:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            execution["requests"] = list(_DingTalkStub.requests)
            if _cards(execution["requests"], "IM_ROBOT"):
                return execution
            time.sleep(0.1)
        self.fail("private notification was not delivered")

    def _wait_no_group_card(self, execution: dict) -> dict:
        # Give asynchronous group delivery time to finish before asserting absence.
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            execution["requests"] = list(_DingTalkStub.requests)
            self.assertEqual(_cards(execution["requests"], "IM_GROUP"), [])
            time.sleep(0.1)
        return execution

    def _wait_group_card(self, execution: dict) -> dict:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            execution["requests"] = list(_DingTalkStub.requests)
            if _cards(execution["requests"], "IM_GROUP"):
                return execution
            time.sleep(0.1)
        self.fail("group notification was not delivered")

    def _wait_webhook(self, execution: dict) -> list[dict]:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            requests = list(_DingTalkStub.requests)
            execution["requests"] = requests
            hooks = [entry for entry in requests if entry["path"] == "/webhook"]
            if hooks:
                return hooks
            time.sleep(0.1)
        self.fail("custom webhook was not delivered")

    def _execute(self, prompt: str, shell_type: str) -> dict:
        self.shell_type = shell_type
        self._configure_model_response(prompt)
        team = self._create_shell_resources(shell_type)
        channel_id = self._create_messager_channel()
        subscription_id = self._create_subscription(prompt, team, channel_id)
        execution = self._api(
            "POST", f"/api/subscriptions/{subscription_id}/trigger"
        ).json()
        execution = self._wait_execution(subscription_id, execution["id"])
        self._wait_private_card(execution)
        return execution

    def test_chat_real_execution(self) -> None:
        result = self._execute("只输出：测试，现在时间：{{time}}", "Chat")
        self._wait_group_card(result)
        self.assertEqual(result["status"], "COMPLETED")
        self.assertTrue(result["summary"])
        group = _cards(result["requests"], "IM_GROUP")
        self.assertEqual(len(group), 1)
        self.assertNotIn("【", group[0]["cardData"]["cardParamMap"]["content"])

        hooks = self._wait_webhook(result)
        self.assertEqual(len(hooks), 1)
        self.assertIn("测试，现在时间", hooks[0]["payload"]["content"])

    def test_silent_real_execution_keeps_private(self) -> None:
        result = self._execute(
            "只输出两行：第一行“测试，现在时间：{{time}}”，最后一行【静默】", "Chat"
        )
        self.assertEqual(result["status"], "COMPLETED")
        self._wait_no_group_card(result)
        private = _cards(result["requests"], "IM_ROBOT")
        self.assertEqual(len(private), 1)
        self.assertNotIn("静默", private[0]["cardData"]["cardParamMap"]["content"])
        hooks = self._wait_webhook(result)
        self.assertNotIn("静默", hooks[0]["payload"]["content"])

    def test_mention_real_execution(self) -> None:
        result = self._execute(
            "只输出两行：第一行“测试，现在时间：{{time}}”，最后一行【@列表：900101】",
            "Chat",
        )
        self._wait_group_card(result)
        self.assertEqual(result["status"], "COMPLETED")
        group = _cards(result["requests"], "IM_GROUP")
        self.assertEqual(len(group), 1)
        self.assertIn("900101", group[0]["imGroupOpenDeliverModel"]["atUserIds"])
        self.assertNotIn("【", group[0]["cardData"]["cardParamMap"]["content"])
        self.assertTrue(group[0]["imGroupOpenDeliverModel"].get("atUserIds"))

    def test_silence_wins_over_mention_real_execution(self) -> None:
        result = self._execute(
            "只输出两行：第一行“测试，现在时间：{{time}}”，"
            "最后一行【静默】【@列表：900101】",
            "Chat",
        )
        self.assertEqual(result["status"], "COMPLETED")
        self._wait_no_group_card(result)
        self.assertEqual(len(_cards(result["requests"], "IM_ROBOT")), 1)

    def test_group_delivery_failure_does_not_block_private(self) -> None:
        _DingTalkStub.fail_group = True
        result = self._execute(
            "只输出两行：第一行“测试，现在时间：{{time}}”，最后一行【@列表：900101】",
            "Chat",
        )
        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(_cards(result["requests"], "IM_GROUP"), [])
        self.assertEqual(len(_cards(result["requests"], "IM_ROBOT")), 1)
        failed_group_calls = [
            entry for entry in result["requests"] if entry.get("forced_failure")
        ]
        self.assertEqual(len(failed_group_calls), 1)

    def test_claudecode_real_execution(self) -> None:
        result = self._execute("只输出：测试，现在时间：{{time}}", "ClaudeCode")
        self._wait_group_card(result)
        self.assertEqual(result["status"], "COMPLETED")
        self.assertTrue(result["summary"])
        self.assertEqual(len(_cards(result["requests"], "IM_GROUP")), 1)

    def test_claudecode_silent_execution(self) -> None:
        result = self._execute(
            "只输出两行：第一行“测试，现在时间：{{time}}”，最后一行【静默】",
            "ClaudeCode",
        )
        self.assertEqual(result["status"], "COMPLETED")
        self._wait_no_group_card(result)
        self.assertEqual(len(_cards(result["requests"], "IM_ROBOT")), 1)

    def test_claudecode_mention_execution(self) -> None:
        result = self._execute(
            "只输出两行：第一行“测试，现在时间：{{time}}”，最后一行【@列表：900101】",
            "ClaudeCode",
        )
        self._wait_group_card(result)
        self.assertEqual(result["status"], "COMPLETED")
        group = _cards(result["requests"], "IM_GROUP")
        self.assertEqual(len(group), 1)
        self.assertIn("900101", group[0]["imGroupOpenDeliverModel"]["atUserIds"])

    def test_claudecode_silence_wins_over_mention(self) -> None:
        result = self._execute(
            "只输出两行：第一行“测试，现在时间：{{time}}”，"
            "最后一行【静默】【@列表：900101】",
            "ClaudeCode",
        )
        self.assertEqual(result["status"], "COMPLETED")
        self._wait_no_group_card(result)
        self.assertEqual(len(_cards(result["requests"], "IM_ROBOT")), 1)


if __name__ == "__main__":
    report_dir = Path(os.environ["E2E_REPORT_DIR"])
    report_dir.mkdir(parents=True, exist_ok=True)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(
        SubscriptionExecutionNotificationDirectives
    )
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    (report_dir / "result.json").write_text(
        json.dumps(
            {
                "sha": os.environ.get("E2E_TEST_SHA"),
                "command": COMMAND,
                "tests": result.testsRun,
                "failures": len(result.failures),
                "errors": len(result.errors),
            },
            indent=2,
        )
        + "\n"
    )
    raise SystemExit(0 if result.wasSuccessful() else 1)
