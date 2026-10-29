# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real DingTalk tenant coverage for subscription notification controls.

This is an opt-in protected-environment check, not the public protocol suite.
Only the model service and the webhook receiver are local. DingTalk calls use
the actual OpenAPI and real test group/users supplied by protected variables.
No tenant identifiers, credentials, request bodies or card contents are written
to the report. The test creates isolated database records and cleans them up.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from redis import Redis

from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.subscription_follow import InvitationStatus, SubscriptionFollow
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from shared.utils.crypto import encrypt_sensitive_data

COMMAND = "uv run --no-sync python tests/e2e/dingtalk_subscription_real_tenant.py"
REQUIRED_ENV = (
    "E2E_DINGTALK_CLIENT_ID",
    "E2E_DINGTALK_CLIENT_secret",
    "E2E_DINGTALK_CARD_TEMPLATE_ID",
    "E2E_DINGTALK_GROUP_ID",
    "E2E_DINGTALK_STAFF_ID",
    "DWS_BINARY_PATH",
    "E2E_API_URL",
    "E2E_MODEL_URL",
    "E2E_BOOTSTRAP_ADMIN_PASSWORD",
    "WEGENT_HYBRID_STATE_FILE",
    "E2E_REPORT_DIR",
)


class _WebhookHandler(BaseHTTPRequestHandler):
    received: list[dict] = []

    def log_message(self, *_args) -> None:
        return

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        type(self).received.append(json.loads(body or b"{}"))
        self.send_response(200)
        self.end_headers()


def _require_environment() -> None:
    if os.environ.get("E2E_DINGTALK_REAL_TENANT") != "1":
        raise RuntimeError("Real DingTalk E2E requires explicit protected opt-in")
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"Missing protected DingTalk settings: {', '.join(missing)}")
    assert settings.DATABASE_URL.startswith("mysql"), "Real MySQL is required"


class RealDingTalkSubscription(unittest.TestCase):
    """Verify actual tenant delivery without exposing tenant data in reports."""

    @classmethod
    def setUpClass(cls) -> None:
        _require_environment()
        state = dict(
            line.split("=", 1)
            for line in Path(os.environ["WEGENT_HYBRID_STATE_FILE"])
            .read_text()
            .splitlines()
        )
        for process in ("rust", "python"):
            os.kill(int(state[process]), 0)
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            assert redis.ping(), "Real Redis is required"
        cls.staff_id = os.environ["E2E_DINGTALK_STAFF_ID"]
        cls.group_id = os.environ["E2E_DINGTALK_GROUP_ID"]
        cls.client = httpx.Client(
            base_url=os.environ["E2E_API_URL"].rstrip("/"),
            timeout=30,
            trust_env=False,
        )
        cls.api = cls.client
        response = cls.api.post(
            "/api/auth/admin-password/setup",
            json={"password": os.environ["E2E_BOOTSTRAP_ADMIN_PASSWORD"]},
        )
        if response.status_code not in (200, 201, 409):
            raise AssertionError("failed to initialize isolated test administrator")
        login = cls.api.post(
            "/api/auth/login",
            json={
                "user_name": "admin",
                "password": os.environ["E2E_BOOTSTRAP_ADMIN_PASSWORD"],
            },
        )
        login.raise_for_status()
        cls.api.headers["Authorization"] = f"Bearer {login.json()['access_token']}"
        cls.webhook = ThreadingHTTPServer(("0.0.0.0", 0), _WebhookHandler)
        if expected_port := os.environ.get("E2E_WEBHOOK_PORT"):
            cls.webhook.server_close()
            cls.webhook = ThreadingHTTPServer(
                ("0.0.0.0", int(expected_port)), _WebhookHandler
            )
        cls.webhook_thread = threading.Thread(
            target=cls.webhook.serve_forever, daemon=True
        )
        cls.webhook_thread.start()
        cls.evidence: dict[str, bool] = {}

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()
        cls.webhook.shutdown()
        cls.webhook.server_close()
        cls.webhook_thread.join(timeout=5)
        report = Path(os.environ["E2E_REPORT_DIR"]) / "result.json"
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(
            json.dumps(
                {
                    "mode": "real_dingtalk_tenant",
                    "external_delivery": True,
                    "tenant_data_included": False,
                    "sha": os.environ.get("E2E_TEST_SHA"),
                    "scenarios": cls.evidence,
                },
                indent=2,
            )
            + "\n"
        )

    def setUp(self) -> None:
        self.marker = f"real-tenant-{uuid.uuid4().hex}"
        self.started_at = datetime.now().astimezone()
        _WebhookHandler.received = []
        self.created: list[tuple[str, object]] = []
        with SessionLocal() as db:
            user = User(
                user_name=self.marker,
                password_hash=get_password_hash(uuid.uuid4().hex),
                role="user",
                auth_source="password",
                is_active=True,
            )
            db.add(user)
            db.commit()
            self.user_id = user.id
            self.addCleanup(self._cleanup)
            channel = Kind(
                user_id=0,
                kind="Messager",
                name=f"{self.marker}-channel",
                namespace="default",
                is_active=True,
                json={
                    "kind": "Messager",
                    "metadata": {
                        "name": f"{self.marker}-channel",
                        "namespace": "default",
                    },
                    "spec": {
                        "channelType": "dingtalk",
                        "isEnabled": False,
                        "config": {
                            "client_id": os.environ["E2E_DINGTALK_CLIENT_ID"],
                            "client_secret": encrypt_sensitive_data(
                                os.environ["E2E_DINGTALK_CLIENT_secret"]
                            ),
                            "card_template_id": os.environ[
                                "E2E_DINGTALK_CARD_TEMPLATE_ID"
                            ],
                        },
                    },
                },
            )
            db.add(channel)
            db.commit()
            self.channel_id = channel.id
            self.created.append(("messager", channel.id))
            user.preferences = json.dumps(
                {
                    "im_channels": {
                        str(channel.id): {
                            "channel_type": "dingtalk",
                            "sender_id": self.staff_id,
                            "sender_staff_id": self.staff_id,
                        }
                    }
                }
            )
            subscription = Kind(
                user_id=user.id,
                kind="Subscription",
                name=self.marker,
                namespace="default",
                is_active=True,
                json={
                    "kind": "Subscription",
                    "metadata": {"name": self.marker, "namespace": "default"},
                    "spec": {
                        "displayName": self.marker,
                        "trigger": {
                            "type": "cron",
                            "cron": {"expression": "0 0 * * *", "timezone": "UTC"},
                        },
                        "teamRef": {"name": self.marker, "namespace": "default"},
                        "promptTemplate": self.marker,
                        "enabled": False,
                        "notificationWebhooks": [
                            {
                                "type": "custom",
                                "url": (
                                    f"{os.environ.get('E2E_WEBHOOK_HOST', 'http://host.docker.internal')}:"
                                    f"{self.webhook.server_address[1]}"
                                    "/webhook"
                                ),
                                "enabled": True,
                            }
                        ],
                    },
                    "_internal": {
                        "team_id": 0,
                        "enabled": False,
                        "trigger_type": "cron",
                        "notification_channel_bindings": {
                            str(channel.id): {
                                "bind_private": True,
                                "bind_group": True,
                                "group_conversation_id": self.group_id,
                                "group_name": "Protected E2E group",
                                "group_mention_user_ids": ["stale-user"],
                            }
                        },
                    },
                },
            )
            db.add(subscription)
            db.commit()
            self.subscription_id = subscription.id
            self.created.append(("subscription", subscription.id))
            db.add(
                SubscriptionFollow(
                    subscription_id=subscription.id,
                    follower_user_id=user.id,
                    follow_type="direct",
                    invited_by_user_id=0,
                    invitation_status=InvitationStatus.ACCEPTED.value,
                    config=json.dumps(
                        {
                            "notification_level": "notify",
                            "notification_channel_ids": [channel.id],
                        }
                    ),
                )
            )
            db.commit()

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
                    continue
                else:
                    path = {
                        "model": f"/api/v1/namespaces/default/models/{identifier}",
                        "bot": f"/api/bots/{identifier}",
                        "team": f"/api/v1/namespaces/default/teams/{identifier}",
                    }[kind]
                    self.api.delete(path)
            except Exception:
                pass
        with SessionLocal() as db:
            db.query(SubscriptionFollow).filter(
                SubscriptionFollow.follower_user_id == self.user_id
            ).delete(synchronize_session=False)
            for model in (BackgroundExecution, Subtask, TaskResource, Kind):
                db.query(model).filter(model.user_id == self.user_id).delete(
                    synchronize_session=False
                )
            db.query(Kind).filter(Kind.id == self.channel_id).delete(
                synchronize_session=False
            )
            db.query(User).filter(User.id == self.user_id).delete(
                synchronize_session=False
            )
            db.commit()

    def _api(self, method: str, path: str, expected=(200,), **kwargs):
        response = self.api.request(method, path, **kwargs)
        if response.status_code not in expected:
            self.fail(f"isolated subscription API failed: {method} {path}")
        return response

    def _create_chat_execution(self) -> None:
        model_name = f"real-model-{uuid.uuid4().hex}"
        bot_name = f"real-bot-{uuid.uuid4().hex}"
        team_name = f"real-team-{uuid.uuid4().hex}"
        self._api(
            "POST",
            "/api/v1/namespaces/default/models",
            json={
                "kind": "Model",
                "metadata": {"name": model_name, "namespace": "default"},
                "spec": {
                    "modelConfig": {
                        "env": {
                            "model": "openai",
                            "model_id": "mock-e2e-model",
                            "small_model": "mock-e2e-small-model",
                            "api_key": "mock-api-key",
                            "base_url": os.environ["E2E_MODEL_URL"],
                        }
                    }
                },
            },
            expected=(200, 201),
        )
        self.created.append(("model", model_name))
        bot = self._api(
            "POST",
            "/api/bots",
            json={
                "name": bot_name,
                "shell_name": "Chat",
                "namespace": "default",
                "agent_config": {
                    "bind_model": model_name,
                    "bind_model_type": "user",
                },
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
                "description": "Protected real DingTalk E2E",
                "bots": [{"bot_id": bot["id"], "bot_prompt": "", "role": "worker"}],
                "bind_mode": ["chat"],
                "requires_workspace": False,
                "is_active": True,
            },
            expected=(201,),
        ).json()
        self.created.append(("team", team_name))
        marker = self.marker
        self.api.post(
            os.environ["E2E_MODEL_URL"].removesuffix("/v1") + "/stream-rules",
            json={
                "matchText": "测试，现在时间",
                "responseContent": f"测试，现在时间：{marker}",
                "chunkDelayMs": 0,
                "doneDelayMs": 0,
            },
        ).raise_for_status()
        subscription = self._api(
            "POST",
            "/api/subscriptions",
            json={
                "display_name": marker,
                "task_type": "collection",
                "trigger_type": "cron",
                "trigger_config": {"expression": "0 0 * * *", "timezone": "UTC"},
                "team_id": team["id"],
                "model_ref": {"name": model_name, "namespace": "default"},
                "force_override_bot_model": True,
                "prompt_template": "只输出：测试，现在时间：{{time}}",
                "enabled": True,
                "execution_target": {"type": "managed", "device_id": None},
                "notification_webhooks": [],
            },
            expected=(201,),
        ).json()
        subscription_id = subscription.get("id")
        if not subscription_id:
            items = self._api("GET", "/api/subscriptions").json()["items"]
            subscription_id = next(
                item["id"] for item in items if item["display_name"] == marker
            )
        self.created.append(("subscription", subscription_id))
        self._api(
            "PUT",
            f"/api/subscriptions/{subscription_id}/developer/notification-settings",
            json={
                "notification_level": "notify",
                "notification_channel_ids": [self.channel_id],
                "channel_binding_configs": [
                    {
                        "channel_id": self.channel_id,
                        "bind_private": True,
                        "bind_group": True,
                        "group_conversation_id": self.group_id,
                        "group_name": "Protected E2E group",
                    }
                ],
            },
        )
        with SessionLocal() as db:
            admin = db.query(User).filter(User.user_name == "admin").first()
            admin.preferences = json.dumps(
                {
                    "im_channels": {
                        str(self.channel_id): {
                            "channel_type": "dingtalk",
                            "sender_id": self.staff_id,
                            "sender_staff_id": self.staff_id,
                        }
                    }
                }
            )
            db.commit()
        execution = self._api(
            "POST", f"/api/subscriptions/{subscription_id}/trigger"
        ).json()
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            with SessionLocal() as db:
                state = db.get(BackgroundExecution, execution["id"])
                if state.status == "COMPLETED":
                    self.assertIn(self.marker, state.result_summary)
                    self._wait_group(True)
                    self.evidence["chat_real_execution"] = True
                    return
                self.assertNotEqual(state.status, "FAILED")
            time.sleep(0.25)
        self.fail("real Chat subscription execution did not finish")

    def test_chat_execution(self) -> None:
        self._create_chat_execution()

    def _complete(self, text: str) -> dict:
        with SessionLocal() as db:
            task = TaskResource(
                user_id=self.user_id,
                kind="Task",
                name=f"{self.marker}-{uuid.uuid4().hex}",
                namespace="default",
                is_active=TaskResource.STATE_SUBSCRIPTION,
                json={
                    "kind": "Task",
                    "metadata": {"name": self.marker, "namespace": "default"},
                    "spec": {
                        "title": self.marker,
                        "prompt": self.marker,
                        "teamRef": {"name": self.marker, "namespace": "default"},
                        "workspaceRef": {"name": self.marker, "namespace": "default"},
                    },
                    "status": {"status": "RUNNING"},
                },
            )
            db.add(task)
            db.flush()
            subtask = Subtask(
                user_id=self.user_id,
                task_id=task.id,
                team_id=0,
                title=self.marker,
                bot_ids=[],
                role=SubtaskRole.ASSISTANT,
                status=SubtaskStatus.RUNNING,
                executor_deleted_at=True,
            )
            execution = BackgroundExecution(
                user_id=self.user_id,
                subscription_id=self.subscription_id,
                task_id=task.id,
                trigger_type="manual",
                trigger_reason=self.marker,
                prompt=self.marker,
                status="RUNNING",
            )
            db.add_all([subtask, execution])
            db.commit()
            task_id, subtask_id, execution_id = task.id, subtask.id, execution.id
        response = self.client.post(
            "/api/internal/callback",
            json={
                "event_type": "response.completed",
                "task_id": task_id,
                "subtask_id": subtask_id,
                "data": {
                    "response": {
                        "status": "completed",
                        "output": [
                            {
                                "type": "message",
                                "role": "assistant",
                                "content": [{"type": "output_text", "text": text}],
                            }
                        ],
                    }
                },
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            with SessionLocal() as db:
                execution = db.get(BackgroundExecution, execution_id)
                if execution.status == "COMPLETED":
                    return {
                        "summary": execution.result_summary,
                        "hooks": list(_WebhookHandler.received),
                    }
                self.assertNotEqual(execution.status, "FAILED")
            time.sleep(0.2)
        self.fail("real tenant execution did not complete")

    def _dws(self, *arguments: str) -> dict:
        """Read tenant state with isolated protected CI credentials."""
        env = os.environ.copy()
        config = env.get("E2E_DWS_CONFIG_DIR")
        if config:
            env["DWS_CONFIG_DIR"] = config
            env["DWS_DISABLE_KEYCHAIN"] = "1"
        command = [
            os.environ["DWS_BINARY_PATH"],
            *arguments,
            "--format",
            "json",
        ]
        if profile := env.get("E2E_DWS_PROFILE"):
            command.extend(["--profile", profile])
        result = subprocess.run(
            command,
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=45,
        )
        return json.loads(result.stdout)

    def _group_contains_marker(self) -> bool:
        result = self._dws(
            "chat",
            "message",
            "list",
            "--group",
            self.group_id,
            "--time",
            self.started_at.strftime("%Y-%m-%d %H:%M:%S"),
            "--direction",
            "newer",
            "--limit",
            "50",
        )
        return self.marker in json.dumps(result, ensure_ascii=False)

    def _mention_contains_marker(self) -> bool:
        result = self._dws(
            "chat",
            "message",
            "list-mentions",
            "--group",
            self.group_id,
            "--start",
            self.started_at.isoformat(),
            "--end",
            (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
            "--limit",
            "50",
        )
        return self.marker in json.dumps(result, ensure_ascii=False)

    def _wait_group(self, expected: bool) -> None:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self._group_contains_marker() == expected:
                return
            time.sleep(1)
        self.fail(f"real group delivery did not reach expected state {expected}")

    def _wait_mention(self, expected: bool = True) -> None:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self._mention_contains_marker() == expected:
                return
            time.sleep(1)
        self.fail(f"real DingTalk mention did not reach expected state {expected}")

    def test_silent_private_and_webhook(self) -> None:
        result = self._complete(f"{self.marker}\n\n【静默】")
        self.assertEqual(result["summary"], self.marker)
        self.assertEqual(len(result["hooks"]), 1)
        self.assertNotIn("静默", result["hooks"][0]["content"])
        self._wait_group(False)
        self.evidence["silent_private_webhook"] = True

    def test_mention_actual_group(self) -> None:
        result = self._complete(f"{self.marker}\n\n【@列表：{self.staff_id}】")
        self.assertEqual(result["summary"], self.marker)
        self._wait_group(True)
        self._wait_mention()
        self.evidence["mention_actual_group"] = True

    def test_silence_wins(self) -> None:
        result = self._complete(f"{self.marker}\n\n【静默】【@列表：{self.staff_id}】")
        self.assertEqual(result["summary"], self.marker)
        self._wait_group(False)
        self.evidence["silence_wins"] = True

    def test_plain_empty_invalid_targets(self) -> None:
        for suffix in ("", "【@列表：】", "【@列表：张三】"):
            result = self._complete(f"{self.marker}\n\n{suffix}")
            self.assertEqual(result["summary"], self.marker)
            self._wait_group(True)
            self._wait_mention(False)
        self.evidence["plain_empty_invalid_targets"] = True


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RealDingTalkSubscription)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
