# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise injected system MCP URLs through real Rust/Python, MySQL and Redis.

Run directly, outside pytest's service-mocking conftest. The shared gateway E2E
environment supplies both Backend processes and their real dependencies.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from redis import Redis
from sqlalchemy.engine import make_url

from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.auth.task_token import create_task_token
from app.services.execution.request_builder import TaskRequestBuilder

COMMAND = "uv run --no-sync python tests/e2e/system_mcp_gateway.py"


class SystemMcpGateway(unittest.TestCase):
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
        cls.gateway_url = os.environ["E2E_API_URL"].rstrip("/")
        assert urlsplit(cls.gateway_url).port != int(state["python_port"])
        database = make_url(settings.DATABASE_URL)
        assert database.drivername.startswith("mysql"), "Real MySQL is required"
        assert database.database.endswith(("_test", "_e2e")), "Use an E2E database"
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            assert redis.ping(), "Real Redis is required"
        cls.client = httpx.Client(timeout=30, trust_env=False)
        cls.evidence: list[dict] = []

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()
        (Path(os.environ["E2E_REPORT_DIR"]) / "persistence.json").write_text(
            json.dumps(cls.evidence, indent=2) + "\n"
        )

    def setUp(self) -> None:
        self.marker = f"system-mcp-{uuid.uuid4().hex}"
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
            task = TaskResource(
                user_id=user.id,
                kind="Task",
                name=self.marker,
                namespace="default",
                is_active=TaskResource.STATE_SUBSCRIPTION,
                json={
                    "kind": "Task",
                    "metadata": {"name": self.marker, "namespace": "default"},
                    "spec": {"title": self.marker, "prompt": self.marker},
                    "status": {"status": "RUNNING"},
                },
            )
            db.add(task)
            db.flush()
            subtask = Subtask(
                user_id=user.id,
                task_id=task.id,
                team_id=0,
                title=self.marker,
                bot_ids=[],
                role=SubtaskRole.ASSISTANT,
                status=SubtaskStatus.RUNNING,
            )
            db.add(subtask)
            db.commit()
            self.task_id, self.subtask_id = task.id, subtask.id

    def _cleanup(self) -> None:
        with SessionLocal() as db:
            for model in (Subtask, TaskResource, User):
                column = model.id if model is User else model.user_id
                db.query(model).filter(column == self.user_id).delete(
                    synchronize_session=False
                )
            db.commit()

    def _snapshot(self) -> dict:
        with SessionLocal() as db:
            subtask = db.get(Subtask, self.subtask_id)
            return {
                "subtask_id": subtask.id,
                "status": subtask.status.value,
                "progress": subtask.progress,
                "result": subtask.result,
                "completed": subtask.completed_at is not None,
            }

    def _rpc(self, config: dict, method: str, params: dict | None = None) -> dict:
        response = self.client.post(
            config["url"],
            headers={
                **config["auth"],
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": "2025-03-26",
            },
            json={
                "jsonrpc": "2.0",
                "id": method,
                "method": method,
                "params": params or {},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertNotIn("error", body, body)
        return body["result"]

    def _verify_injected_url(self, suffix: str) -> None:
        previous_url, previous_prefix = (
            settings.BACKEND_INTERNAL_URL,
            settings.API_PREFIX,
        )
        self.addCleanup(setattr, settings, "BACKEND_INTERNAL_URL", previous_url)
        self.addCleanup(setattr, settings, "API_PREFIX", previous_prefix)
        settings.BACKEND_INTERNAL_URL = f"{self.gateway_url}{suffix}"
        settings.API_PREFIX = "/api"
        token = create_task_token(
            self.task_id, self.subtask_id, self.user_id, self.marker
        )
        with SessionLocal() as db:
            configs = TaskRequestBuilder(db)._get_auto_injected_system_mcp(token)
        self.assertEqual(len(configs), 1)
        config = configs[0]
        self.assertEqual(config["name"], "wegent-system")
        self.assertEqual(self._snapshot()["status"], "RUNNING")
        initialized = self._rpc(
            config,
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "system-mcp-gateway-e2e", "version": "1"},
            },
        )
        self.assertEqual(initialized["serverInfo"]["name"], "wegent-system-mcp")
        tools = self._rpc(config, "tools/list")["tools"]
        self.assertIn("silent_exit", {tool["name"] for tool in tools})
        result = self._rpc(
            config,
            "tools/call",
            {"name": "silent_exit", "arguments": {"reason": self.marker}},
        )
        self.assertFalse(result.get("isError", False), result)
        marker = json.loads(result["content"][0]["text"])
        self.assertEqual(marker, {"__silent_exit__": True, "reason": self.marker})
        after = self._snapshot()
        self.assertEqual(after["status"], "COMPLETED", after)
        self.assertEqual(after["progress"], 100, after)
        self.assertTrue(after["completed"], after)
        self.assertIs(after["result"]["silent_exit"], True)
        self.assertEqual(after["result"]["silent_exit_reason"], self.marker)
        self.evidence.append(
            {"base_suffix": suffix, "url": config["url"], "after": after}
        )

    def test_origin(self) -> None:
        self._verify_injected_url("")

    def test_origin_with_slash(self) -> None:
        self._verify_injected_url("/")

    def test_api_base(self) -> None:
        self._verify_injected_url("/api")

    def test_api_base_with_slash(self) -> None:
        self._verify_injected_url("/api/")


if __name__ == "__main__":
    report_dir = Path(os.environ["E2E_REPORT_DIR"])
    report_dir.mkdir(parents=True, exist_ok=True)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SystemMcpGateway)
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
