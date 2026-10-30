# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify subscription notification directives through the real product path.

Run directly, outside pytest's service-mocking conftest. Only the outward
DingTalk OpenAPI and the enterprise directory are served by a local HTTP stub;
the subscription execution, completion event, directive parsing, notification
dispatch, DingTalk sender, execution persistence and webhook delivery all run
through product code and the real hybrid gateway.
"""

from __future__ import annotations

import json
import os
import threading
import time
import unittest
import uuid
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

COMMAND = "uv run --no-sync python tests/e2e/subscription_notification_directives.py"

CAPTURED: list[dict] = []
CAPTURE_LOCK = threading.Lock()


class _StubHandler(BaseHTTPRequestHandler):
    """Serve the DingTalk OpenAPI shapes the sender consumes."""

    def log_message(self, *_args) -> None:  # noqa: D102 - quiet test output
        return

    def _record(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except ValueError:
            payload = {"raw": body.decode("utf-8", "replace")}
        with CAPTURE_LOCK:
            CAPTURED.append({"path": self.path, "payload": payload})

    def _reply(self, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        self._record(body)
        if self.path.endswith("/oauth2/accessToken"):
            self._reply({"accessToken": "e2e-token", "expireIn": 7200})
            return
        if self.path.endswith("/card/instances/createAndDeliver"):
            payload = json.loads(body or b"{}")
            self._reply(
                {
                    "success": True,
                    "result": {
                        "outTrackId": payload.get("outTrackId"),
                        "deliverResults": [{"success": True}],
                    },
                }
            )
            return
        self._reply({"success": True})

    def do_PUT(self) -> None:  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        self._record(self.rfile.read(length))
        self._reply({"success": True})


def _captured_paths(since: int) -> list[dict]:
    with CAPTURE_LOCK:
        return list(CAPTURED[since:])


def _card_payloads(entries: list[dict], space: str) -> list[dict]:
    return [
        entry["payload"]
        for entry in entries
        if entry["path"].endswith("/card/instances/createAndDeliver")
        and str(entry["payload"].get("openSpaceId", "")).startswith(
            f"dtv1.card//{space}."
        )
    ]


class SubscriptionNotificationDirectives(unittest.TestCase):
    """Drive real subscription completions and inspect real deliveries."""

    @classmethod
    def setUpClass(cls) -> None:
        state = dict(
            line.split("=", 1)
            for line in Path(os.environ["WEGENT_HYBRID_STATE_FILE"])
            .read_text()
            .splitlines()
        )
        for process in ("rust", "python"):
            os.kill(int(state[process]), 0)
        assert settings.DATABASE_URL.startswith("mysql"), "Real MySQL is required"
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            assert redis.ping(), "Real Redis is required"
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
        cls.stub_url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.server_thread = threading.Thread(
            target=cls.server.serve_forever, daemon=True
        )
        cls.server_thread.start()
        cls.client = httpx.Client(
            base_url=os.environ["E2E_API_URL"].rstrip("/"),
            timeout=30,
            trust_env=False,
        )
        cls.evidence: list[dict] = []

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()
        cls.server.shutdown()
        cls.server.server_close()
        report = Path(os.environ["E2E_REPORT_DIR"]) / "notification-directives.json"
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(cls.evidence, indent=2) + "\n")

    def setUp(self) -> None:
        suffix = uuid.uuid4().hex
        marker = f"directives-e2e-{suffix}"
        self.marker = marker
        with SessionLocal() as db:
            user = User(
                user_name=marker,
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
                name=f"{marker}-channel",
                namespace="default",
                is_active=True,
                json={
                    "kind": "Messager",
                    "metadata": {"name": f"{marker}-channel", "namespace": "default"},
                    "spec": {
                        "channelType": "dingtalk",
                        "isEnabled": False,
                        "config": {
                            "client_id": "e2e-client-id",
                            "client_secret": encrypt_sensitive_data(
                                "e2e-client-secret"
                            ),
                            "card_template_id": "e2e-card-template",
                            "api_base_url": self.stub_url,
                        },
                    },
                },
            )
            db.add(channel)
            db.commit()
            self.channel_id = channel.id

            user.preferences = json.dumps(
                {
                    "im_channels": {
                        str(channel.id): {
                            "channel_type": "dingtalk",
                            "sender_id": "900101",
                            "sender_staff_id": "900101",
                        }
                    }
                }
            )
            subscription = Kind(
                user_id=user.id,
                kind="Subscription",
                name=marker,
                namespace="default",
                is_active=True,
                json={
                    "kind": "Subscription",
                    "metadata": {"name": marker, "namespace": "default"},
                    "spec": {
                        "displayName": marker,
                        "trigger": {
                            "type": "cron",
                            "cron": {"expression": "0 0 * * *", "timezone": "UTC"},
                        },
                        "teamRef": {"name": marker, "namespace": "default"},
                        "promptTemplate": marker,
                        "enabled": False,
                        "notificationWebhooks": [
                            {
                                "type": "custom",
                                "url": f"{self.stub_url}/webhook",
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
                                "group_conversation_id": f"cid-e2e-{suffix}",
                                "group_name": "E2E group",
                                # Legacy static mentions must never create targets.
                                "group_mention_user_ids": ["stale-user"],
                            }
                        },
                    },
                },
            )
            db.add(subscription)
            db.commit()
            self.subscription_id = subscription.id
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

    def _run_completion(self, text: str) -> dict:
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

        start = len(_captured_paths(0))
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

        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            with SessionLocal() as db:
                execution = db.get(BackgroundExecution, execution_id)
                status = execution.status
                summary = execution.result_summary
            if status != "RUNNING":
                break
            time.sleep(0.1)
        else:
            self.fail("execution did not complete")
        self.assertEqual(status, "COMPLETED")

        # Deliveries run asynchronously inside the completion handler.
        expected = _captured_paths(start)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            expected = _captured_paths(start)
            if _card_payloads(expected, "IM_ROBOT") and any(
                entry["path"] == "/webhook" for entry in expected
            ):
                break
            time.sleep(0.1)

        evidence = {"text": text, "summary": summary, "requests": expected}
        self.evidence.append(evidence)
        return evidence

    def test_silent_skips_group_but_keeps_private_and_cleans_markers(self) -> None:
        evidence = self._run_completion("Build finished\n\n【静默】")
        requests = evidence["requests"]
        self.assertEqual(_card_payloads(requests, "IM_GROUP"), [])
        private = _card_payloads(requests, "IM_ROBOT")
        self.assertEqual(len(private), 1)
        self.assertIn(
            "Build finished", private[0]["cardData"]["cardParamMap"]["content"]
        )
        self.assertNotIn("静默", private[0]["cardData"]["cardParamMap"]["content"])
        self.assertEqual(evidence["summary"], "Build finished")
        webhook = [entry for entry in requests if entry["path"] == "/webhook"]
        self.assertEqual(len(webhook), 1)
        self.assertNotIn("静默", json.dumps(webhook[0]["payload"], ensure_ascii=False))

    def test_mention_reaches_group_card(self) -> None:
        evidence = self._run_completion("Build failed\n\n【@列表：900101】")
        group = _card_payloads(evidence["requests"], "IM_GROUP")
        self.assertEqual(len(group), 1)
        model = group[0]["imGroupOpenDeliverModel"]
        self.assertIn("900101", model.get("atUserIds", {}))
        self.assertIn("@", group[0]["cardData"]["cardParamMap"]["content"])
        self.assertNotIn("【", group[0]["cardData"]["cardParamMap"]["content"])
        self.assertEqual(evidence["summary"], "Build failed")

    def test_silence_wins_over_mentions(self) -> None:
        evidence = self._run_completion("Quiet\n\n【静默】【@列表：900101】")
        self.assertEqual(_card_payloads(evidence["requests"], "IM_GROUP"), [])
        self.assertEqual(len(_card_payloads(evidence["requests"], "IM_ROBOT")), 1)
        self.assertEqual(evidence["summary"], "Quiet")

    def test_empty_or_invalid_mentions_never_create_targets(self) -> None:
        for text in ("Report\n\n【@列表：】", "Report\n\n【@列表：张三】"):
            with self.subTest(text=text):
                evidence = self._run_completion(text)
                group = _card_payloads(evidence["requests"], "IM_GROUP")
                self.assertEqual(len(group), 1)
                self.assertEqual(
                    group[0]["imGroupOpenDeliverModel"].get("atUserIds"), None
                )
                self.assertEqual(evidence["summary"], "Report")

    def test_legacy_static_mentions_never_create_targets(self) -> None:
        evidence = self._run_completion("All good")
        group = _card_payloads(evidence["requests"], "IM_GROUP")
        self.assertEqual(len(group), 1)
        self.assertNotIn("atUserIds", group[0]["imGroupOpenDeliverModel"])
        self.assertNotIn("stale-user", json.dumps(group[0]))

    def test_plain_message_delivers_without_mentions(self) -> None:
        evidence = self._run_completion("All good")
        group = _card_payloads(evidence["requests"], "IM_GROUP")
        self.assertEqual(len(group), 1)
        self.assertNotIn("atUserIds", group[0]["imGroupOpenDeliverModel"])
        self.assertEqual(evidence["summary"], "All good")


if __name__ == "__main__":
    report_dir = Path(os.environ["E2E_REPORT_DIR"])
    report_dir.mkdir(parents=True, exist_ok=True)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(
        SubscriptionNotificationDirectives
    )
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {
        "sha": os.environ.get("E2E_TEST_SHA"),
        "command": COMMAND,
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
    }
    (report_dir / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
