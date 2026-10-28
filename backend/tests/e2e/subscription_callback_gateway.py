# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify subscription MCP and completion through the real hybrid gateway.

Run directly, outside pytest's service-mocking conftest. CI supplies the same
running Backend, MySQL and Redis used by the other gateway API E2E tests.
Only fixture rows are inserted directly; callbacks traverse the public listener,
the Rust callback handler and the subscription completion handler.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import time
import unittest
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

import httpx
from redis import Redis

from app.core.config import settings
from app.core.security import create_access_token, get_password_hash
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.auth.task_token import create_task_token

COMMAND = "uv run --no-sync python tests/e2e/subscription_callback_gateway.py"


class SubscriptionCallbackGateway(unittest.TestCase):
    """Exercise subscription tools and callbacks without replacing services."""

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
        base_url = os.environ["E2E_API_URL"].rstrip("/")
        assert urlparse(base_url).port != int(state["python_port"])
        assert settings.DATABASE_URL.startswith("mysql"), "Real MySQL is required"
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            assert redis.ping(), "Real Redis is required"
        cls.client = httpx.Client(base_url=base_url, timeout=30, trust_env=False)
        cls.rust_log = Path(os.environ["E2E_RUST_LOG"])
        assert cls.rust_log.is_file(), "Rust process log is required"
        cls.evidence: list[dict] = []

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()
        (Path(os.environ["E2E_REPORT_DIR"]) / "persistence.json").write_text(
            json.dumps(cls.evidence, indent=2) + "\n"
        )

    def setUp(self) -> None:
        suffix = uuid.uuid4().hex
        self.marker = f"callback-gateway-{suffix}"
        with SessionLocal() as db:
            user = User(
                user_name=self.marker,
                password_hash=get_password_hash(secrets.token_urlsafe(24)),
                role="user",
                auth_source="password",
                is_active=True,
            )
            db.add(user)
            db.commit()
            self.user_id = user.id
            self.addCleanup(self._cleanup)
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
                    },
                },
            )
            task = TaskResource(
                user_id=user.id,
                kind="Task",
                name=self.marker,
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
            db.add_all([subscription, task])
            db.flush()
            subtask = Subtask(
                user_id=user.id,
                task_id=task.id,
                team_id=0,
                title=self.marker,
                bot_ids=[],
                role=SubtaskRole.ASSISTANT,
                status=SubtaskStatus.RUNNING,
                # The runtime has already been released before its callback arrives.
                # This uses the real cleanup path without needing a model execution.
                executor_deleted_at=True,
            )
            execution = BackgroundExecution(
                user_id=user.id,
                subscription_id=subscription.id,
                task_id=task.id,
                trigger_type="manual",
                trigger_reason=self.marker,
                prompt=self.marker,
                status="RUNNING",
            )
            db.add_all([subtask, execution])
            db.commit()
            self.task_id, self.subtask_id, self.execution_id = (
                task.id,
                subtask.id,
                execution.id,
            )

    def _cleanup(self) -> None:
        with SessionLocal() as db:
            for model in (BackgroundExecution, Subtask, TaskResource, Kind):
                db.query(model).filter(model.user_id == self.user_id).delete(
                    synchronize_session=False
                )
            db.query(User).filter(User.id == self.user_id).delete(
                synchronize_session=False
            )
            db.commit()

    def _snapshot(self) -> dict:
        # Each read owns a new MySQL session: no ORM cache or old read snapshot
        # can make an uncommitted callback update appear durable.
        with SessionLocal() as db:
            execution = db.get(BackgroundExecution, self.execution_id)
            task = db.get(TaskResource, self.task_id)
            subtask = db.get(Subtask, self.subtask_id)
            return {
                "execution_id": execution.id,
                "task_id": task.id,
                "subtask_id": subtask.id,
                "execution_status": execution.status,
                "task_status": task.json["status"]["status"],
                "subtask_status": subtask.status.value,
                "version": execution.version,
                "result_summary": execution.result_summary,
                "error_message": execution.error_message,
            }

    def _callback(self, event_type: str, data: dict, expected: str) -> dict:
        before = self._snapshot()
        for field in ("execution_status", "task_status", "subtask_status"):
            self.assertEqual(before[field], "RUNNING", before)
        response = self.client.post(
            "/api/internal/callback",
            json={
                "event_type": event_type,
                "task_id": self.task_id,
                "subtask_id": self.subtask_id,
                "data": data,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        deadline = time.monotonic() + 10
        while True:
            after = self._snapshot()
            if after["execution_status"] != "RUNNING":
                break
            self.assertLess(time.monotonic(), deadline, after)
            time.sleep(0.1)
        for field in ("execution_status", "task_status", "subtask_status"):
            self.assertEqual(after[field], expected, after)
            self.assertNotEqual(after[field], "RUNNING")
        self.assertEqual(after["version"], before["version"] + 1)
        # Breeze flushes asynchronously; require the migrated handler's receipt
        # for this exact callback as well as its durable database side effects.
        deadline = time.monotonic() + 5
        receipt_fields = {
            f"task_id={self.task_id}",
            f"subtask_id={self.subtask_id}",
            f'status="{expected}"',
        }
        while True:
            receipts = [
                line
                for line in self.rust_log.read_text().splitlines()
                if "TaskCompletedEvent received" in line
            ]
            if any(receipt_fields <= set(line.split()) for line in receipts):
                break
            self.assertLess(time.monotonic(), deadline, receipts)
            time.sleep(0.1)
        self.evidence.append(
            {"event_type": event_type, "before": before, "after": after}
        )
        return after

    def test_completed_callback_persists_subscription_completion(self) -> None:
        after = self._callback(
            "response.completed",
            {
                "response": {
                    "status": "completed",
                    "output": [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": self.marker}],
                        }
                    ],
                }
            },
            "COMPLETED",
        )
        self.assertIn(self.marker, after["result_summary"])

    def test_error_callback_persists_subscription_failure(self) -> None:
        after = self._callback(
            "error", {"message": self.marker, "code": "runtime_error"}, "FAILED"
        )
        self.assertEqual(after["error_message"], self.marker)

    def test_cancelled_callback_persists_subscription_cancellation(self) -> None:
        self._callback("response.incomplete", {}, "CANCELLED")

    def _subscription_tool(self, name: str, arguments: dict) -> dict:
        """Call a real gateway MCP tool using this fixture user's task token."""
        token = create_task_token(
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            user_id=self.user_id,
            user_name=self.marker,
        )
        response = self.client.post(
            "/api/mcp/subscription/sse",
            headers={
                "Accept": "application/json, text/event-stream",
                "Authorization": f"Bearer {token}",
            },
            json={
                "jsonrpc": "2.0",
                "id": self.marker,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        rpc = response.json()
        self.assertNotIn("error", rpc, rpc)
        self.assertFalse(rpc["result"].get("isError", False), rpc)
        return json.loads(rpc["result"]["content"][0]["text"])

    def _prepare_subscription_mcp(self) -> None:
        """Create an active Team and task for this user's subscription tools."""
        with SessionLocal() as db:
            db.add(
                Kind(
                    user_id=self.user_id,
                    kind="Team",
                    name=self.marker,
                    namespace="default",
                    is_active=True,
                    json={
                        "kind": "Team",
                        "metadata": {"name": self.marker, "namespace": "default"},
                        "spec": {"bots": []},
                    },
                )
            )
            db.get(TaskResource, self.task_id).is_active = TaskResource.STATE_ACTIVE
            db.commit()

    def _cleanup_subscription_preview(self, preview_id: str) -> None:
        """Remove only the current fixture's preview and streaming blocks."""
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            redis.delete(
                f"subscription:preview:{preview_id}",
                f"chat:streaming:blocks:{self.subtask_id}",
            )

    def test_subscription_mcp_preview_and_confirmed_create(self) -> None:
        """Persist a preview without creating, then confirm and consume it."""
        self._prepare_subscription_mcp()
        arguments = {
            "display_name": self.marker,
            "trigger_type": "one_time",
            "execute_at": (datetime.now() + timedelta(days=7)).isoformat(),
            "prompt_template": self.marker,
        }
        preview = self._subscription_tool("preview_subscription", arguments)
        self.assertTrue(preview["__silent_exit__"], preview)
        self.assertEqual(preview["type"], "subscription_preview")
        self.assertEqual(preview["status"], "pending")
        preview_id = preview["preview_id"]
        self.addCleanup(self._cleanup_subscription_preview, preview_id)
        key = f"subscription:preview:{preview_id}"
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            stored = json.loads(redis.get(key))
            self.assertEqual(stored["user_id"], self.user_id)
            self.assertEqual(stored["prompt_template"], self.marker)
            blocks = redis.lrange(f"chat:streaming:blocks:{self.subtask_id}", 0, -1)
            self.assertTrue(
                any(
                    json.loads(block).get("preview_id") == preview_id
                    for block in blocks
                )
            )
        with SessionLocal() as db:
            count = (
                db.query(Kind)
                .filter_by(user_id=self.user_id, kind="Subscription")
                .count()
            )
            self.assertEqual(count, 1, "Preview must not create a subscription")

        created = self._subscription_tool(
            "create_subscription", {**arguments, "preview_id": preview_id}
        )
        self.assertTrue(created["success"], created)
        with SessionLocal() as db:
            subscription = (
                db.query(Kind)
                .filter_by(
                    id=created["subscription"]["id"],
                    user_id=self.user_id,
                    kind="Subscription",
                    namespace="default",
                )
                .one()
            )
            self.assertEqual(subscription.json["spec"]["promptTemplate"], self.marker)
            self.assertEqual(
                subscription.json["spec"]["trigger"]["one_time"]["execute_at"],
                arguments["execute_at"],
            )
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            self.assertFalse(redis.exists(key), "Creation must consume its preview")
        self.evidence.append({"preview_id": preview_id, "created": created})

    def _subscription_count(self) -> int:
        """Read the user's persisted subscriptions through a fresh session."""
        with SessionLocal() as db:
            return (
                db.query(Kind)
                .filter_by(
                    user_id=self.user_id, kind="Subscription", namespace="default"
                )
                .count()
            )

    def _new_subscription_preview(self) -> tuple[dict, str, bytes]:
        """Generate and retain a real Redis preview for confirmation assertions."""
        arguments = {
            "display_name": self.marker,
            "trigger_type": "one_time",
            "execute_at": (datetime.now() + timedelta(days=7)).isoformat(),
            "prompt_template": self.marker,
        }
        result = self._subscription_tool("preview_subscription", arguments)
        self.assertTrue(result["__silent_exit__"], result)
        preview_id = result["preview_id"]
        self.addCleanup(self._cleanup_subscription_preview, preview_id)
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            raw = redis.get(f"subscription:preview:{preview_id}")
        self.assertIsNotNone(raw)
        self.assertEqual(json.loads(raw)["user_id"], self.user_id)
        return arguments, preview_id, raw

    def _confirm_preview(
        self, entrypoint: str, arguments: dict, preview_id: str
    ) -> tuple[int, dict]:
        """Use the authenticated MCP or web confirmation entry through the gateway."""
        if entrypoint == "mcp":
            return 200, self._subscription_tool(
                "create_subscription", {**arguments, "preview_id": preview_id}
            )
        self.assertEqual(entrypoint, "web")
        token = create_access_token({"sub": self.marker})
        response = self.client.post(
            f"/api/subscriptions/preview/{preview_id}/confirm",
            headers={"Authorization": f"Bearer {token}"},
        )
        return response.status_code, response.json()

    def _assert_preview_preserved(self, preview_id: str, expected: bytes) -> None:
        """Require a rejected confirmation to retain the complete Redis preview."""
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            self.assertEqual(redis.get(f"subscription:preview:{preview_id}"), expected)

    def _assert_owner_can_confirm(
        self, entrypoint: str, arguments: dict, preview_id: str
    ) -> None:
        """Require the owner's creation to persist its prompt and consume the preview."""
        before = self._subscription_count()
        status, result = self._confirm_preview(entrypoint, arguments, preview_id)
        self.assertEqual(status, 200, result)
        if entrypoint == "mcp":
            self.assertTrue(result["success"], result)
            subscription_id = result["subscription"]["id"]
        else:
            subscription_id = result["id"]
        self.assertEqual(self._subscription_count(), before + 1)
        with SessionLocal() as db:
            subscription = (
                db.query(Kind)
                .filter_by(
                    id=subscription_id,
                    user_id=self.user_id,
                    kind="Subscription",
                    namespace="default",
                )
                .one()
            )
            self.assertEqual(subscription.json["spec"]["promptTemplate"], self.marker)
            self.assertEqual(subscription.json["spec"]["teamRef"]["name"], self.marker)
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            self.assertFalse(redis.exists(f"subscription:preview:{preview_id}"))
        self.evidence.append(
            {
                "confirmation_entrypoint": entrypoint,
                "preview_id": preview_id,
                "subscription_id": subscription_id,
            }
        )

    def test_subscription_preview_rejects_other_users_across_entrypoints(self) -> None:
        """Reject another valid owner at both entries without consuming its preview."""
        self._prepare_subscription_mcp()
        # Reuse the same real user/task/Team fixture with independent cleanup.
        other = type(self)(self._testMethodName)

        def cleanup_other() -> None:
            """Surface peer fixture cleanup failures in the current test result."""
            self.assertTrue(other.doCleanups(), "Peer fixture cleanup failed")

        self.addCleanup(cleanup_other)
        other.setUp()
        other._prepare_subscription_mcp()
        for owner_entrypoint in ("mcp", "web"):
            with self.subTest(owner_entrypoint=owner_entrypoint):
                arguments, preview_id, raw = self._new_subscription_preview()
                counts = (self._subscription_count(), other._subscription_count())
                for attacker_entrypoint in ("mcp", "web"):
                    status, result = other._confirm_preview(
                        attacker_entrypoint, arguments, preview_id
                    )
                    if attacker_entrypoint == "mcp":
                        self.assertEqual(status, 200, result)
                        self.assertFalse(result["success"], result)
                        message = result["error"]
                    else:
                        self.assertEqual(status, 403, result)
                        message = result["detail"]
                    self.assertEqual(message, "Not authorized to confirm this preview")
                    self.assertEqual(
                        (self._subscription_count(), other._subscription_count()),
                        counts,
                    )
                    self._assert_preview_preserved(preview_id, raw)
                self._assert_owner_can_confirm(owner_entrypoint, arguments, preview_id)
                self.assertEqual(other._subscription_count(), counts[1])

    def _set_subscription_team_active(self, active: bool) -> None:
        """Change the real fixture Team to exercise creation failure and recovery."""
        with SessionLocal() as db:
            team = (
                db.query(Kind)
                .filter_by(
                    user_id=self.user_id,
                    kind="Team",
                    name=self.marker,
                    namespace="default",
                )
                .one()
            )
            team.is_active = active
            db.commit()

    def test_subscription_preview_survives_failed_creation_across_entrypoints(
        self,
    ) -> None:
        """Retain failed previews and confirm them after restoring their Team."""
        self._prepare_subscription_mcp()
        for entrypoint in ("mcp", "web"):
            with self.subTest(entrypoint=entrypoint):
                arguments, preview_id, raw = self._new_subscription_preview()
                count = self._subscription_count()
                self._set_subscription_team_active(False)
                try:
                    status, result = self._confirm_preview(
                        entrypoint, arguments, preview_id
                    )
                    if entrypoint == "mcp":
                        self.assertEqual(status, 200, result)
                        self.assertFalse(result["success"], result)
                        message = result["error"]
                    else:
                        self.assertEqual(status, 400, result)
                        message = result["detail"]
                    self.assertIn("Team with id", message)
                    self.assertIn("not found", message)
                    self.assertEqual(self._subscription_count(), count)
                    self._assert_preview_preserved(preview_id, raw)
                finally:
                    self._set_subscription_team_active(True)
                self._assert_owner_can_confirm(entrypoint, arguments, preview_id)


if __name__ == "__main__":
    report_dir = Path(os.environ["E2E_REPORT_DIR"])
    report_dir.mkdir(parents=True, exist_ok=True)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(
        SubscriptionCallbackGateway
    )
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {
        "sha": os.environ["E2E_TEST_SHA"],
        "command": COMMAND,
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skipped": len(result.skipped),
        "success": result.wasSuccessful()
        and result.testsRun == 6
        and not result.skipped,
    }
    (report_dir / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    sys.exit(0 if report["success"] else 1)
