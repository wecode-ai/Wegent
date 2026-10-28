# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify subscription completion through the real hybrid gateway and MySQL.

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
from pathlib import Path
from urllib.parse import urlparse

import httpx
from redis import Redis

from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User

COMMAND = "uv run --no-sync python tests/e2e/subscription_callback_gateway.py"


class SubscriptionCallbackGateway(unittest.TestCase):
    """Persist three terminal callbacks without replacing any product service."""

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
        and result.testsRun == 3
        and not result.skipped,
    }
    (report_dir / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    sys.exit(0 if report["success"] else 1)
