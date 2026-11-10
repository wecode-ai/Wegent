# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify subscription MCP and completion through the real hybrid gateway.

Run directly, outside pytest's service-mocking conftest. CI supplies the same
running Backend, MySQL and Redis used by the other gateway API E2E tests.
Only fixture rows are inserted directly. Callbacks traverse the public Rust
gateway; the Python-owned subscription MCP tools are verified on both the
public gateway and the direct Python upstream.
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
from app.core.security import get_password_hash
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
        """Verify the real gateway services and capture their shared clients."""
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
        cls.route = os.environ["E2E_SUBSCRIPTION_ROUTE"]
        assert cls.route in {"python", "rust"}
        cls.client = httpx.Client(base_url=base_url, timeout=30, trust_env=False)
        cls.mcp_client = cls.client
        if cls.route == "python":
            cls.mcp_client = httpx.Client(
                base_url=f"http://127.0.0.1:{state['python_port']}",
                timeout=30,
                trust_env=False,
            )
            cls.python_log = Path(os.environ["E2E_PYTHON_LOG"])
            assert cls.python_log.is_file(), "Python process log is required"
        cls.handler_log = Path(os.environ["E2E_RUST_LOG"])
        assert cls.handler_log.is_file(), "Rust process log is required"
        cls.evidence: list[dict] = []

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()
        cls.mcp_client.close()
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
            (
                self.task_id,
                self.subtask_id,
                self.execution_id,
                self.fixture_subscription_id,
            ) = (
                task.id,
                subtask.id,
                execution.id,
                subscription.id,
            )

    def _cleanup(self) -> None:
        """Remove all rows owned by this test user."""
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
        """Send a callback and wait for durable state and handler receipt."""
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
        self._assert_handler_receipt(expected)
        self.evidence.append(
            {"event_type": event_type, "before": before, "after": after}
        )
        return after

    def _assert_handler_receipt(self, expected: str) -> None:
        """Wait for the migrated Rust handler to log this callback receipt."""
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
                for line in self.handler_log.read_text().splitlines()
                if "TaskCompletedEvent received" in line
            ]
            if any(receipt_fields <= set(line.split()) for line in receipts):
                break
            self.assertLess(time.monotonic(), deadline, receipts)
            time.sleep(0.1)

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

    def test_task_queue_terminal_failure_reaches_backend(self) -> None:
        """Verify a queue-consumer failure through the real callback endpoint."""
        from executor_manager.clients import callback_client as callback_client_module
        from executor_manager.executors.dispatcher import ExecutorDispatcher
        from executor_manager.services.task_queue_consumer import TaskQueueConsumer
        from executor_manager.services.task_queue_service import (
            PENDING_INDEX_KEY,
            PENDING_KEY_TEMPLATE,
            TaskQueueService,
        )

        previous_api_domain = os.environ.get("TASK_API_DOMAIN")
        previous_dequeue_timeout = os.environ.get("TASK_QUEUE_DEQUEUE_TIMEOUT")
        os.environ["TASK_API_DOMAIN"] = os.environ["E2E_API_URL"].rstrip("/")
        os.environ["TASK_QUEUE_DEQUEUE_TIMEOUT"] = "1"
        callback_client_module._callback_client = None

        service_pool = f"e2e-terminal-{uuid.uuid4().hex}"
        service = TaskQueueService(service_pool=service_pool, queue_type="online")
        consumer = TaskQueueConsumer(
            service_pool=service_pool,
            queue_type="online",
        )
        consumer._backpressure_wait = 0.01
        original_executors = ExecutorDispatcher._executors
        ExecutorDispatcher._executors = {"custom": object()}
        task = {
            "metadata": {
                "task_id": self.task_id,
                "subtask_id": self.subtask_id,
                "executor_type": "docker",
            }
        }

        try:
            assert service.enqueue_task(task)
            consumer.start()
            deadline = time.monotonic() + 10
            while True:
                after = self._snapshot()
                if after["subtask_status"] != "RUNNING":
                    break
                self.assertLess(time.monotonic(), deadline, after)
                time.sleep(0.1)

            self.assertEqual(after["execution_status"], "FAILED", after)
            self.assertEqual(after["task_status"], "FAILED", after)
            self.assertEqual(after["subtask_status"], "FAILED", after)
            self.assertEqual(
                after["error_message"],
                "Default 'docker' executor not found",
                after,
            )
            redis_client = service.redis_client
            assert redis_client is not None
            deadline = time.monotonic() + 10
            while True:
                queue_empty = redis_client.llen(service.queue_key) == 0
                pending_removed = (
                    not redis_client.exists(
                        PENDING_KEY_TEMPLATE.format(task_id=self.task_id)
                    )
                    and redis_client.zscore(PENDING_INDEX_KEY, str(self.task_id))
                    is None
                )
                if queue_empty and pending_removed:
                    break
                self.assertLess(time.monotonic(), deadline, after)
                time.sleep(0.1)

            self.assertEqual(redis_client.llen(service.queue_key), 0)
            self.assertEqual(
                redis_client.exists(PENDING_KEY_TEMPLATE.format(task_id=self.task_id)),
                0,
            )
            self.assertIsNone(redis_client.zscore(PENDING_INDEX_KEY, str(self.task_id)))
        finally:
            consumer.stop()
            redis_client = service.redis_client
            if redis_client is not None:
                redis_client.delete(
                    service.queue_key,
                    PENDING_KEY_TEMPLATE.format(task_id=self.task_id),
                )
                redis_client.zrem(PENDING_INDEX_KEY, str(self.task_id))
            ExecutorDispatcher._executors = original_executors
            callback_client_module._callback_client = None
            if previous_api_domain is None:
                os.environ.pop("TASK_API_DOMAIN", None)
            else:
                os.environ["TASK_API_DOMAIN"] = previous_api_domain
            if previous_dequeue_timeout is None:
                os.environ.pop("TASK_QUEUE_DEQUEUE_TIMEOUT", None)
            else:
                os.environ["TASK_QUEUE_DEQUEUE_TIMEOUT"] = previous_dequeue_timeout

    def test_cancelled_callback_persists_subscription_cancellation(self) -> None:
        self._callback("response.incomplete", {}, "CANCELLED")

    def _subscription_tool(
        self,
        name: str,
        arguments: dict,
        *,
        user_id: int | None = None,
        user_name: str | None = None,
    ) -> dict:
        """Call a real subscription MCP tool as the requested user."""
        token = create_task_token(
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            user_id=user_id or self.user_id,
            user_name=user_name or self.marker,
        )
        response = self.mcp_client.post(
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

    def _cleanup_user(self, user_id: int) -> None:
        with SessionLocal() as db:
            db.query(User).filter(User.id == user_id).delete(synchronize_session=False)
            db.commit()

    def _prepare_subscription_mcp(self) -> None:
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
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            redis.delete(
                f"subscription:preview:{preview_id}",
                f"chat:streaming:blocks:{self.subtask_id}",
            )

    def test_subscription_mcp_preview_and_confirmed_create(self) -> None:
        """Cover subscription creation, reads, filtering, and isolation."""
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
        if self.route == "python":
            self.assertIn(
                "request : POST /api/mcp/subscription/sse ",
                self.python_log.read_text(),
            )
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            self.assertFalse(redis.exists(key), "Creation must consume its preview")
        subscription_id = created["subscription"]["id"]

        fetched = self._subscription_tool(
            "get_subscription", {"subscription_id": subscription_id}
        )
        self.assertTrue(fetched["success"], fetched)
        self.assertEqual(fetched["subscription"]["id"], subscription_id)
        self.assertEqual(fetched["subscription"]["prompt_template"], self.marker)
        self.assertTrue(fetched["subscription"]["enabled"])
        self.assertTrue(fetched["subscription"]["is_active"])
        self.assertEqual(fetched["subscription"]["execution_count"], 0)
        self.assertIsNotNone(fetched["subscription"]["next_execution_time"])

        with SessionLocal() as db:
            db.get(Kind, self.fixture_subscription_id).updated_at = datetime(2021, 1, 1)
            db.get(Kind, subscription_id).updated_at = datetime(2020, 1, 1)
            db.commit()

        listed = self._subscription_tool("list_subscriptions", {})
        self.assertTrue(listed["success"], listed)
        self.assertEqual(listed["total"], 2)
        self.assertEqual(listed["returned"], 2)
        self.assertEqual(
            {item["id"] for item in listed["items"]},
            {self.fixture_subscription_id, subscription_id},
        )
        self.assertTrue(all(item["is_active"] for item in listed["items"]))
        self.assertTrue(all(not item["is_rental"] for item in listed["items"]))

        enabled_list = self._subscription_tool(
            "list_subscriptions", {"enabled": True, "trigger_type": "one_time"}
        )
        self.assertTrue(enabled_list["success"], enabled_list)
        self.assertEqual(enabled_list["total"], 1)
        self.assertEqual(enabled_list["returned"], 1)
        self.assertEqual(enabled_list["items"][0]["id"], subscription_id)
        self.assertEqual(enabled_list["items"][0]["trigger_type"], "one_time")
        self.assertNotIn("prompt_template", enabled_list["items"][0])

        page = self._subscription_tool("list_subscriptions", {"offset": 1, "limit": 1})
        self.assertTrue(page["success"], page)
        self.assertEqual(page["total"], 2)
        self.assertEqual(page["returned"], 1)
        self.assertEqual(page["items"][0]["id"], subscription_id)
        first_page = self._subscription_tool(
            "list_subscriptions", {"offset": 0, "limit": 1}
        )
        self.assertTrue(first_page["success"], first_page)
        self.assertEqual(first_page["returned"], 1)
        self.assertEqual(first_page["items"][0]["id"], self.fixture_subscription_id)

        with SessionLocal() as db:
            owner_subscription = db.get(Kind, self.fixture_subscription_id)
            rental_json = json.loads(json.dumps(owner_subscription.json))
            rental_internal = rental_json.setdefault("_internal", {})
            rental_internal["is_rental"] = True
            rental_json["_internal"] = rental_internal
            db.add(
                Kind(
                    user_id=self.user_id,
                    kind="Subscription",
                    name=f"{self.marker}-rental",
                    namespace="default",
                    is_active=True,
                    json=rental_json,
                )
            )
            db.commit()

        rental_excluded = self._subscription_tool("list_subscriptions", {})
        self.assertTrue(rental_excluded["success"], rental_excluded)
        self.assertEqual(rental_excluded["total"], 2)
        self.assertNotIn(
            f"{self.marker}-rental",
            {item["name"] for item in rental_excluded["items"]},
        )

        with SessionLocal() as db:
            other_user_name = f"{self.marker[:44]}-other"
            other_user = User(
                user_name=other_user_name,
                password_hash=get_password_hash(secrets.token_urlsafe(24)),
                role="user",
                auth_source="password",
                is_active=True,
            )
            db.add(other_user)
            db.commit()
            self.addCleanup(self._cleanup_user, other_user.id)
            other_user_id = other_user.id

        other_get = self._subscription_tool(
            "get_subscription",
            {"subscription_id": subscription_id},
            user_id=other_user_id,
            user_name=other_user_name,
        )
        self.assertFalse(other_get["success"], other_get)
        self.assertIn("not found", other_get["error"])
        other_list = self._subscription_tool(
            "list_subscriptions",
            {},
            user_id=other_user_id,
            user_name=other_user_name,
        )
        self.assertTrue(other_list["success"], other_list)
        self.assertEqual(other_list["total"], 0)
        self.assertEqual(other_list["items"], [])

        with SessionLocal() as db:
            deleted = db.get(Kind, subscription_id)
            deleted.is_active = False
            deleted_internal = deleted.json.setdefault("_internal", {})
            deleted_internal["enabled"] = False
            deleted.json["_internal"] = deleted_internal
            db.commit()

        deleted_get = self._subscription_tool(
            "get_subscription", {"subscription_id": subscription_id}
        )
        self.assertFalse(deleted_get["success"], deleted_get)
        self.assertIn("not found", deleted_get["error"])
        deleted_list = self._subscription_tool(
            "list_subscriptions", {"trigger_type": "one_time"}
        )
        self.assertTrue(deleted_list["success"], deleted_list)
        self.assertEqual(deleted_list["total"], 0)

        self.evidence.append(
            {
                "preview_id": preview_id,
                "created": created,
                "fetched": fetched,
                "listed": listed,
                "rental_excluded": rental_excluded,
                "other_get": other_get,
                "deleted_get": deleted_get,
            }
        )


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
        and result.testsRun == 4
        and not result.skipped,
    }
    (report_dir / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    sys.exit(0 if report["success"] else 1)
