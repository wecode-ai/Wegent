# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise terminal handoff through the real hybrid gateway and Chat Shell."""

import json
import os
import threading
import time
import unittest
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TypeVar

import httpx
from redis import Redis
from sqlalchemy import text

from app.core.security import create_access_token
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource
from app.models.user import User

T = TypeVar("T")


class TerminalHandoffGateway(unittest.TestCase):
    def setUp(self) -> None:
        self.marker = f"terminal-{uuid.uuid4().hex[:16]}"
        with SessionLocal() as db:
            user = User(
                user_name=self.marker,
                password_hash="",
                git_info={},
                preferences="{}",
                is_active=True,
            )
            db.add(user)
            db.commit()
            self.user_id = user.id
            token = create_access_token({"sub": user.user_name, "user_id": user.id})
        self.addCleanup(self._cleanup_rows)
        self.api = httpx.Client(
            base_url=os.environ["E2E_API_URL"],
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
            trust_env=False,
        )
        self.model = httpx.Client(
            base_url=f'{os.environ.get("E2E_MODEL_URL", "http://localhost:9999")}/e2e/{self.marker}',
            timeout=10,
            trust_env=False,
        )
        self.redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
        for client in (self.api, self.model, self.redis):
            self.addCleanup(client.close)
        self.assertTrue(self.redis.ping())
        self.assertEqual(self._json(self.model.get("/health"))["status"], "ok")

    def _cleanup_rows(self) -> None:
        with SessionLocal() as db:
            for model in (SubtaskContext, Subtask, TaskResource, Kind):
                db.query(model).filter(model.user_id == self.user_id).delete(
                    synchronize_session=False
                )
            db.query(User).filter(User.id == self.user_id).delete()
            db.commit()

    def _json(self, response: httpx.Response, status: int = 200) -> Any:
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def _model_requests(self) -> list[dict]:
        return [
            capture
            for capture in self._json(self.model.get("/captured-requests"))
            if capture["method"] == "POST"
            and capture["url"] in {"/v1/chat/completions", "/v1/responses"}
        ]

    def _create_team(self, *, pipeline: bool) -> tuple[int, list[int]]:
        self._json(
            self.api.post(
                "/api/v1/namespaces/default/models",
                json={
                    "kind": "Model",
                    "metadata": {"name": self.marker, "namespace": "default"},
                    "spec": {
                        "modelConfig": {
                            "env": {
                                "model": "openai",
                                "model_id": "terminal-e2e-model",
                                "api_key": "mock-api-key",
                                "base_url": f"{self.model.base_url}v1",
                            }
                        }
                    },
                },
            ),
            201,
        )
        bots = [
            self._json(
                self.api.post(
                    "/api/bots",
                    json={
                        "name": f"{self.marker}-{stage}",
                        "namespace": "default",
                        "shell_name": "Chat",
                        "agent_config": {
                            "bind_model": self.marker,
                            "bind_model_type": "user",
                        },
                        "system_prompt": f"Return the requested response for stage {stage}.",
                    },
                ),
                201,
            )
            for stage in range(2 if pipeline else 1)
        ]
        config = {
            "name": self.marker,
            "namespace": "default",
            "requires_workspace": False,
            "bind_mode": ["chat"],
            "bots": [
                {
                    "bot_id": bot["id"],
                    "role": "leader" if pipeline and stage == 0 else "worker",
                    "bot_prompt": "",
                    "requireConfirmation": False,
                    "contextPassing": "original_and_previous",
                }
                for stage, bot in enumerate(bots)
            ],
        }
        if pipeline:
            config["workflow"] = {"mode": "pipeline", "leader_bot_id": bots[0]["id"]}
        team = self._json(self.api.post("/api/teams", json=config), 201)
        return team["id"], [bot["id"] for bot in bots]

    def _seed_running_stage(self, team_id: int, bot_id: int) -> tuple[int, int]:
        with SessionLocal() as db:
            task = TaskResource(
                user_id=self.user_id,
                kind="Task",
                name=self.marker,
                namespace="default",
                is_active=TaskResource.STATE_ACTIVE,
                json={
                    "kind": "Task",
                    "metadata": {"name": self.marker, "namespace": "default"},
                    "spec": {
                        "title": self.marker,
                        "prompt": self.marker,
                        "currentStage": 0,
                        "workspaceRef": {"name": self.marker, "namespace": "default"},
                        "teamRef": {
                            "name": self.marker,
                            "namespace": "default",
                            "user_id": self.user_id,
                        },
                    },
                    "status": {"status": "RUNNING"},
                },
            )
            db.add(task)
            db.flush()
            rows = [
                Subtask(
                    task_id=task.id,
                    user_id=self.user_id,
                    team_id=team_id,
                    bot_ids=[bot_id],
                    role=role,
                    status=status,
                    title=self.marker,
                    prompt=prompt,
                    message_id=index,
                    parent_id=index - 1,
                )
                for index, (role, status, prompt) in enumerate(
                    [
                        (SubtaskRole.USER, SubtaskStatus.COMPLETED, self.marker),
                        (SubtaskRole.ASSISTANT, SubtaskStatus.RUNNING, ""),
                    ],
                    start=1,
                )
            ]
            db.add_all(rows)
            db.flush()
            task_id, subtask_id = task.id, rows[-1].id
            db.commit()
        return task_id, subtask_id

    def _snapshot(self, task_id: int) -> tuple[dict, list[dict]]:
        with SessionLocal() as db:
            task = db.get(TaskResource, task_id)
            subtasks = (
                db.query(Subtask)
                .filter(Subtask.task_id == task_id)
                .order_by(Subtask.message_id)
                .all()
            )
            return task.json, [
                {
                    "id": row.id,
                    "status": row.status.value,
                    "role": row.role.value,
                    "result": row.result,
                    "bot_ids": row.bot_ids,
                    "parent": row.parent_id,
                    "message": row.message_id,
                }
                for row in subtasks
            ]

    @contextmanager
    def _reject_handoff_write(
        self, task_id: int, *, after_pair: bool = False
    ) -> Iterator[None]:
        name = self.marker.replace("-", "_")
        operation = "UPDATE" if after_pair else "INSERT"
        condition = (
            "OLD.status = 'PENDING' AND NEW.status = 'RUNNING'"
            if after_pair
            else "NEW.role = 'ASSISTANT'"
        )
        with SessionLocal() as db:
            db.execute(
                text(
                    f"""
                    CREATE TRIGGER {name} BEFORE {operation} ON subtasks
                    FOR EACH ROW BEGIN
                        IF NEW.task_id = {task_id:d} AND {condition} THEN
                            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E handoff write rejected';
                        END IF;
                    END
                    """
                )
            )
            db.commit()
        try:
            yield
        finally:
            with SessionLocal() as db:
                db.execute(text(f"DROP TRIGGER {name}"))
                db.commit()

    def _callback(self, task_id: int, subtask_id: int, answer: str) -> dict:
        # The batch route still belongs to Python in the hybrid route table.
        return self._json(
            self.api.post(
                "/api/internal/callback/batch",
                json=[
                    {
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
                                        "content": [
                                            {"type": "output_text", "text": answer}
                                        ],
                                    }
                                ],
                            }
                        },
                    }
                ],
            )
        )

    def _wait_for(self, check: Callable[[], T | None]) -> T:
        deadline = time.monotonic() + 15
        while True:
            if value := check():
                return value
            self.assertLess(time.monotonic(), deadline, f"Timed out in {self.id()}")
            time.sleep(0.05)

    def test_callback_retries_pipeline_handoff_once(self) -> None:
        team_id, bot_ids = self._create_team(pipeline=True)
        task_id, subtask_id = self._seed_running_stage(team_id, bot_ids[0])
        answer = f"{self.marker}-stage-one"
        second_answer = f"{self.marker}-stage-two"
        self._json(
            self.model.post(
                "/stream-rules",
                json={"matchText": answer, "responseContent": second_answer},
            )
        )
        with self._reject_handoff_write(task_id):
            failed = self._callback(task_id, subtask_id, answer)
            self.assertEqual(failed["status"], "partial", failed)
        before, original = self._snapshot(task_id)
        self.assertEqual(before["spec"]["currentStage"], 0, before)
        self.assertEqual(before["status"]["status"], "PENDING", before)
        self.assertEqual(len(original), 2, original)
        self.assertIn(f"pipelineAutoAdvance:{subtask_id}", before["metadata"]["labels"])
        self.assertEqual(original[-1]["status"], "COMPLETED", original)
        self.assertEqual(original[-1]["result"]["value"], answer)
        self.assertFalse(self._model_requests())

        with self._reject_handoff_write(task_id, after_pair=True):
            failed_claim = self._callback(task_id, subtask_id, "late callback payload")
            self.assertEqual(failed_claim["status"], "partial", failed_claim)
        prepared, saved_rows = self._snapshot(task_id)
        self.assertEqual(prepared["spec"]["currentStage"], 1, prepared)
        self.assertEqual(prepared["status"]["status"], "PENDING", prepared)
        self.assertEqual(len(saved_rows), 4, saved_rows)
        self.assertEqual(saved_rows[-1]["status"], "PENDING", saved_rows)
        self.assertFalse(self._model_requests())

        retried = self._callback(task_id, subtask_id, "late callback payload")
        self.assertEqual(retried["status"], "ok", retried)
        duplicate = self._callback(task_id, subtask_id, "duplicate callback payload")
        self.assertIn("1 skipped", duplicate["message"])

        def completed() -> tuple[dict, list[dict]] | None:
            snapshot = self._snapshot(task_id)
            return (
                snapshot
                if snapshot[0]["status"]["status"] in {"COMPLETED", "FAILED"}
                else None
            )

        after, rows = self._wait_for(completed)
        self.assertEqual(after["status"]["status"], "COMPLETED", (after, rows))
        self.assertEqual(after["spec"]["currentStage"], 1, after)
        self.assertNotIn(
            f"pipelineAutoAdvance:{subtask_id}", after["metadata"]["labels"]
        )
        self.assertEqual(rows[:2], original)
        self.assertEqual([r["id"] for r in rows], [r["id"] for r in saved_rows])
        self.assertEqual([r["role"] for r in rows], ["USER", "ASSISTANT"] * 2)
        self.assertEqual(rows[-1]["bot_ids"], [bot_ids[1]])
        self.assertEqual(rows[-1]["parent"], rows[-2]["message"])
        self.assertEqual(rows[-1]["result"]["value"], second_answer)
        captures = self._model_requests()
        self.assertEqual(len(captures), 1, captures)
        self.assertIn(answer, json.dumps(captures[0]))
        self.assertNotIn("late callback payload", json.dumps(captures[0]))

    def test_cancel_endpoint_settles_active_sse_with_partial_content(self) -> None:
        self._create_team(pipeline=False)
        partial = f"{self.marker}-partial"
        self._json(
            self.model.post(
                "/stream-rules",
                json={
                    "matchText": self.marker,
                    "responseContent": partial,
                    "doneDelayMs": 12_000,
                },
            )
        )
        delta = threading.Event()
        frames: list[dict] = []

        def read_stream() -> None:
            with self.api.stream(
                "POST",
                "/api/v1/responses",
                json={
                    "model": f"default#{self.marker}",
                    "input": self.marker,
                    "stream": True,
                },
            ) as stream:
                if stream.status_code != 200:
                    self.fail(stream.read().decode())
                for line in stream.iter_lines():
                    if line.startswith("data: {"):
                        event = json.loads(line[6:])
                        frames.append(event)
                        if event["type"] == "response.output_text.delta":
                            delta.set()

        with ThreadPoolExecutor(max_workers=1) as executor:
            stream = executor.submit(read_stream)
            if not delta.wait(timeout=15):
                stream.result(timeout=15)
                self.fail(f"No SSE delta received: {frames}")
            response_id = next(
                event["response"]["id"]
                for event in frames
                if event["type"] == "response.created"
            )
            task_id = int(response_id.removeprefix("resp_"))
            task, rows = self._snapshot(task_id)
            self.assertEqual(task["status"]["status"], "RUNNING", task)
            self.assertEqual(rows[-1]["status"], "RUNNING", rows)
            subtask_id = rows[-1]["id"]
            self._wait_for(lambda: self.redis.get(f"chat:streaming:{subtask_id}"))
            cancelled = self._json(
                self.api.post(f"/api/v1/responses/{response_id}/cancel")
            )
            self.assertEqual(cancelled["status"], "completed", cancelled)
            stream.result(timeout=6)

        terminal = [
            frame
            for frame in frames
            if frame["type"] in {"response.completed", "response.failed"}
        ]
        self.assertEqual(
            [frame["type"] for frame in terminal], ["response.completed"], frames
        )
        self.assertEqual(terminal[0]["response"]["status"], "completed")
        after, rows = self._snapshot(task_id)
        self.assertEqual(after["status"]["status"], "COMPLETED")
        self.assertEqual(rows[-1]["status"], "COMPLETED")
        self.assertEqual(rows[-1]["result"]["value"], partial)
        self.assertIsNone(self.redis.get(f"chat:cancel:{subtask_id}"))


if __name__ == "__main__":
    state = dict(
        line.split("=", 1)
        for line in Path(os.environ["WEGENT_HYBRID_STATE_FILE"])
        .read_text()
        .splitlines()
    )
    for process in ("rust", "python"):
        os.kill(int(state[process]), 0)
    unittest.main(verbosity=2)
