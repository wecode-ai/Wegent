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
from concurrent.futures import Future, ThreadPoolExecutor
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

    def _create_team(self, *, pipeline: bool, stages: int = 2) -> tuple[int, list[int]]:
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
            for stage in range(stages if pipeline else 1)
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

    def _seed_running_stage(
        self, team_id: int, bot_id: int, *, suffix: str = ""
    ) -> tuple[int, int]:
        with SessionLocal() as db:
            task = TaskResource(
                user_id=self.user_id,
                kind="Task",
                name=self.marker + suffix,
                namespace="default",
                is_active=TaskResource.STATE_ACTIVE,
                json={
                    "kind": "Task",
                    "metadata": {"name": self.marker + suffix, "namespace": "default"},
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

    @contextmanager
    def _block_pipeline_receiver(
        self, task_id: int, assistant_id: int
    ) -> Iterator[None]:
        # A previous worker owns the dispatch identity. Force a rejected
        # delivery after the writer has committed RUNNING.
        key = f"wegent:lock:pipeline-execution:{task_id}:{assistant_id}"
        self.assertTrue(self.redis.set(key, "fixture", nx=True, ex=20))
        try:
            yield
        finally:
            self.redis.delete(key)

    def _callback(
        self,
        task_id: int,
        subtask_id: int,
        answer: str,
        *,
        rust: bool,
        fail: bool = False,
    ) -> dict:
        event = {
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
                            "content": [{"type": "output_text", "text": answer}],
                        }
                    ],
                }
            },
        }
        # The single callback is Rust-owned. The batch still routes to Python.
        if rust:
            return self._json(
                self.api.post("/api/internal/callback", json=event),
                500 if fail else 200,
            )
        result = self._json(self.api.post("/api/internal/callback/batch", json=[event]))
        self.assertEqual(result["status"], "partial" if fail else "ok", result)
        return result

    def _wait_for(self, check: Callable[[], T | None]) -> T:
        deadline = time.monotonic() + 15
        while True:
            if value := check():
                return value
            self.assertLess(time.monotonic(), deadline, f"Timed out in {self.id()}")
            time.sleep(0.05)

    def test_python_callback_retries_pipeline_handoff_once(self) -> None:
        self._retry_pipeline_handoff(rust=False)

    def test_rust_callback_retries_pipeline_handoff_once(self) -> None:
        self._retry_pipeline_handoff(rust=True)

    def _retry_pipeline_handoff(self, *, rust: bool) -> None:
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
        socket_messages = self.redis.pubsub()
        self.addCleanup(socket_messages.close)
        socket_messages.subscribe("socketio")
        self._wait_for(lambda: socket_messages.get_message(timeout=0.1))

        with self._reject_handoff_write(task_id):
            self._callback(task_id, subtask_id, answer, rust=rust, fail=True)
        before, original = self._snapshot(task_id)
        self.assertEqual(before["spec"]["currentStage"], 0, before)
        self.assertEqual(before["status"]["status"], "PENDING", before)
        self.assertEqual(len(original), 2, original)
        marker = (
            f"terminal-delivery-callback-{subtask_id}"
            if rust
            else f"pipelineAutoAdvance:{subtask_id}"
        )
        self.assertIn(marker, before["metadata"]["labels"])
        self.assertEqual(original[-1]["status"], "COMPLETED", original)
        self.assertEqual(original[-1]["result"]["value"], answer)
        self.assertFalse(self._model_requests())

        with self._reject_handoff_write(task_id, after_pair=True):
            self._callback(
                task_id, subtask_id, "late callback payload", rust=rust, fail=True
            )
        prepared, saved_rows = self._snapshot(task_id)
        self.assertEqual(prepared["spec"]["currentStage"], 1, prepared)
        self.assertEqual(prepared["status"]["status"], "PENDING", prepared)
        self.assertEqual(len(saved_rows), 4, saved_rows)
        self.assertEqual(saved_rows[-1]["status"], "PENDING", saved_rows)
        self.assertFalse(self._model_requests())

        with self._block_pipeline_receiver(task_id, saved_rows[-1]["id"]):
            self._callback(
                task_id, subtask_id, "unaccepted callback", rust=rust, fail=True
            )
            running, pending_rows = self._snapshot(task_id)
            self.assertEqual(running["status"]["status"], "RUNNING", running)
            self.assertEqual(pending_rows[-1]["status"], "RUNNING", pending_rows)
            self.assertIn(marker, running["metadata"]["labels"])
            if rust:
                self.assertIn("pipelinePendingHandoff", running["metadata"]["labels"])
            self.assertFalse(self._model_requests())

        assistant_id = saved_rows[-1]["id"]
        self._json(
            self.model.post(
                "/stream-rules",
                json={
                    "matchText": answer,
                    "responseContent": second_answer,
                    "holdDone": True,
                },
            )
        )
        lease_key = f"wegent:lock:pipeline-execution:{task_id}:{assistant_id}"
        with self._reject_terminal_write(task_id, assistant_id):
            self._callback(task_id, subtask_id, "late callback payload", rust=rust)
            self._wait_for(lambda: self.redis.get(f"chat:streaming:{assistant_id}"))
            self._wait_for(
                lambda: next(
                    (
                        r
                        for r in self._json(self.model.get("/stream-rules"))
                        if r["matchText"] == answer and r["pendingResponses"]
                    ),
                    None,
                )
            )
            inflight, _ = self._snapshot(task_id)
            intent = "pipelinePendingHandoff" if rust else marker
            self.assertIn(intent, inflight["metadata"]["labels"])
            self.assertEqual(inflight["status"]["status"], "RUNNING")
            if rust:
                self._assert_intermediate_frames(socket_messages, task_id, subtask_id)
            self.assertTrue(self.redis.exists(lease_key))
            release = self._json(
                self.model.post("/stream-rules/release", json={"matchText": answer})
            )
            self.assertEqual(release["released"], 1)
            # The original worker saw the terminal frame but its write failed.
            # Recovery must take ownership after the acknowledged worker exits.
            self._wait_for(lambda: not self.redis.exists(lease_key))
            interrupted, rows = self._snapshot(task_id)
            self.assertIn(intent, interrupted["metadata"]["labels"])
            self.assertEqual(rows[-1]["status"], "RUNNING")

        def completed() -> tuple[dict, list[dict]] | None:
            snapshot = self._snapshot(task_id)
            return (
                snapshot
                if snapshot[0]["status"]["status"] in {"COMPLETED", "FAILED"}
                else None
            )

        after, rows = self._wait_for(completed)
        self._wait_for(lambda: not self.redis.exists(lease_key))
        duplicate = self._callback(
            task_id, subtask_id, "duplicate callback payload", rust=rust
        )
        if not rust:
            self.assertIn("1 skipped", duplicate["message"])
        self.assertEqual(after["status"]["status"], "COMPLETED", (after, rows))
        self.assertEqual(after["spec"]["currentStage"], 1, after)
        self.assertNotIn(marker, after["metadata"]["labels"])
        self.assertNotIn("pipelinePendingHandoff", after["metadata"]["labels"])
        self.assertEqual(rows[:2], original)
        self.assertEqual([r["id"] for r in rows], [r["id"] for r in saved_rows])
        self.assertEqual([r["role"] for r in rows], ["USER", "ASSISTANT"] * 2)
        self.assertEqual(rows[-1]["bot_ids"], [bot_ids[1]])
        self.assertEqual(rows[-1]["parent"], rows[-2]["message"])
        self.assertEqual(rows[-1]["result"]["value"], second_answer)
        captures = self._model_requests()
        self.assertEqual(len(captures), 2, captures)
        for capture in captures:
            self.assertIn(answer, json.dumps(capture))
            self.assertNotIn("late callback payload", json.dumps(capture))

    def test_rust_advances_when_all_eight_dispatch_slots_are_busy(self) -> None:
        team_id, bots = self._create_team(pipeline=True, stages=3)
        runs = [
            self._seed_running_stage(team_id, bots[0], suffix=f"-{index}")
            for index in range(8)
        ]
        second = f"{self.marker}-second-stage-answer"
        third = f"{self.marker}-third"
        for index in range(len(runs)):
            self._json(
                self.model.post(
                    "/stream-rules",
                    json={
                        "matchText": f"{self.marker}-first-{index}",
                        "responseContent": second,
                        "holdDone": True,
                    },
                )
            )
        self._json(
            self.model.post(
                "/stream-rules", json={"matchText": second, "responseContent": third}
            )
        )
        for index, (task_id, subtask_id) in enumerate(runs):
            self._callback(
                task_id, subtask_id, f"{self.marker}-first-{index}", rust=True
            )

        def all_slots_occupied() -> bool:
            rules = self._json(self.model.get("/stream-rules"))
            return sum(rule["pendingResponses"] for rule in rules) == len(runs)

        try:
            self._wait_for(all_slots_occupied)
        finally:
            for index in range(len(runs)):
                self._json(
                    self.model.post(
                        "/stream-rules/release",
                        json={"matchText": f"{self.marker}-first-{index}"},
                    )
                )

        def all_tasks_completed() -> bool:
            return all(
                self._snapshot(task_id)[0]["status"]["status"] == "COMPLETED"
                for task_id, _ in runs
            )

        self._wait_for(all_tasks_completed)
        for task_id, _ in runs:
            task, rows = self._snapshot(task_id)
            self.assertEqual(task["spec"]["currentStage"], 2)
            self.assertEqual(len(rows), 6)
            self.assertEqual(rows[-1]["result"]["value"], third)
        self.assertEqual(len(self._model_requests()), 2 * len(runs))

    def test_rust_retries_post_commit_redis_publish(self) -> None:
        team_id, bots = self._create_team(pipeline=True)
        task_id, parent_id = self._seed_running_stage(team_id, bots[0])
        first, second = f"{self.marker}-first", f"{self.marker}-second"
        self._json(
            self.model.post(
                "/stream-rules",
                json={"matchText": first, "responseContent": second, "holdDone": True},
            )
        )
        self._callback(task_id, parent_id, first, rust=True)
        assistant_id = self._snapshot(task_id)[1][-1]["id"]
        marker = f"terminal-delivery-callback-{assistant_id}"
        subscription = self.redis.pubsub()
        self.addCleanup(subscription.close)
        subscription.subscribe(f"callback:channel:{assistant_id}", "socketio")
        for _ in range(2):
            self._wait_for(lambda: subscription.get_message(timeout=0.1))
        self._wait_for(
            lambda: any(
                rule["pendingResponses"]
                for rule in self._json(self.model.get("/stream-rules"))
            )
        )
        # Exercise the real Redis Lua publication failure after the MySQL commit.
        self.redis.execute_command("ACL", "SETUSER", "default", "-publish")
        try:
            self._json(
                self.model.post("/stream-rules/release", json={"matchText": first})
            )
            self._wait_for(
                lambda: self._snapshot(task_id)[1][-1]["status"] == "COMPLETED"
                and not self.redis.exists(f"wegent:lock:{marker}")
            )
            task, rows = self._snapshot(task_id)
            self.assertIn(marker, task["metadata"]["labels"])
            self.assertEqual(rows[-1]["result"]["value"], second)
            self.assertFalse(
                self.redis.exists(
                    f"wegent:terminal-delivery:{task_id}:{assistant_id}:result"
                )
            )
        finally:
            self.redis.execute_command("ACL", "SETUSER", "default", "+publish")

        frames: dict[str, list[dict]] = {"done": [], "chat:done": [], "task:status": []}

        def recovered() -> bool:
            message = subscription.get_message(timeout=0.1)
            if message and message["type"] == "message":
                data = json.loads(message["data"])
                if data.get("type") == "done":
                    frames["done"].append(data)
                elif data.get("event") in {"chat:done", "task:status"}:
                    frame = data["data"][0]
                    if frame.get("subtask_id") == assistant_id or (
                        frame.get("task_id") == task_id
                        and frame.get("status") == "COMPLETED"
                    ):
                        frames[data["event"]].append(frame)
            return (
                all(frames.values())
                and marker not in self._snapshot(task_id)[0]["metadata"]["labels"]
            )

        self._wait_for(recovered)
        self.assertEqual(
            {name: len(events) for name, events in frames.items()},
            {
                "done": 1,
                "chat:done": 1,
                "task:status": 1,
            },
        )
        self.assertEqual(frames["done"][0]["result"]["value"], second)
        self.assertEqual(len(self._model_requests()), 1)

    @contextmanager
    def _reject_terminal_write(self, task_id: int, subtask_id: int) -> Iterator[None]:
        name = f"{self.marker.replace('-', '_')}_terminal"
        with SessionLocal() as db:
            db.execute(
                text(
                    f"""
                CREATE TRIGGER {name} BEFORE UPDATE ON subtasks
                FOR EACH ROW BEGIN
                    IF NEW.task_id = {task_id:d} AND NEW.id = {subtask_id:d}
                       AND NEW.status IN ('COMPLETED','FAILED','CANCELLED') THEN
                        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E terminal write rejected';
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

    def _assert_intermediate_frames(
        self, subscription: Any, task_id: int, subtask_id: int
    ) -> None:
        statuses: list[str] = []
        stage_done: list[int] = []

        def received() -> bool:
            message = subscription.get_message(timeout=0.1)
            if message and message["type"] == "message":
                frame = json.loads(message["data"])
                data = frame["data"][0]
                if data.get("task_id") == task_id:
                    if (
                        frame["event"] == "task:status"
                        and frame["room"] == f"user:{self.user_id}"
                    ):
                        statuses.append(data["status"])
                    elif (
                        frame["event"] == "chat:done"
                        and frame["room"] == f"task:{task_id}"
                    ):
                        stage_done.append(data["subtask_id"])
            return bool(stage_done and statuses and statuses[-1] == "RUNNING")

        self._wait_for(received)
        self.assertEqual(statuses, ["PENDING", "RUNNING"])
        self.assertEqual(stage_done, [subtask_id])

    def test_cancel_endpoint_settles_active_sse_with_partial_content(self) -> None:
        self._cancel_active_stream(terminal_arrives_first=False)

    def test_sse_terminal_frame_uses_cancellation_already_committed_in_mysql(
        self,
    ) -> None:
        self._cancel_active_stream(terminal_arrives_first=True)

    def test_sse_error_uses_cancellation_already_committed_in_mysql(self) -> None:
        self._cancel_active_stream(
            terminal_arrives_first=True,
            upstream_error="model failure after partial output",
        )

    def _cancel_active_stream(
        self, *, terminal_arrives_first: bool, upstream_error: str | None = None
    ) -> None:
        self._create_team(pipeline=False)
        partial = f"{self.marker}-partial"
        self._json(
            self.model.post(
                "/stream-rules",
                json={
                    "matchText": self.marker,
                    "responseContent": partial,
                    "holdDone": True,
                    "terminalError": upstream_error,
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

        with ThreadPoolExecutor(max_workers=2) as executor:
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
            if terminal_arrives_first:
                self._finish_upstream_during_cancel(
                    stream, response_id, task_id, subtask_id
                )
            else:
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

    def _finish_upstream_during_cancel(
        self, stream: Future[None], response_id: str, task_id: int, subtask_id: int
    ) -> None:
        # The model gate and a MySQL advisory lock put the terminal frame in
        # flight while the cancel endpoint owns the task and subtask row locks.
        # Rust must then render the winning committed result even though its
        # terminal handler began before the Redis cancellation flag was set.
        lock_name = self.marker
        trigger = f"{self.marker.replace('-', '_')}_cancel"
        with SessionLocal() as ddl:
            ddl.execute(
                text(
                    f"""
                    CREATE TRIGGER {trigger} BEFORE UPDATE ON subtasks
                    FOR EACH ROW BEGIN
                        IF NEW.id = {subtask_id:d} AND NEW.status = 'COMPLETED'
                           AND NEW.progress = 100 THEN
                            IF GET_LOCK('{lock_name}', 10) = 1 THEN
                                DO RELEASE_LOCK('{lock_name}');
                            END IF;
                        END IF;
                    END
                    """
                )
            )
            ddl.commit()
        try:
            with ThreadPoolExecutor(max_workers=1) as executor, SessionLocal() as lock:
                self.assertEqual(
                    lock.scalar(text("SELECT GET_LOCK(:name, 0)"), {"name": lock_name}),
                    1,
                )
                try:
                    cancel = executor.submit(
                        self.api.post, f"/api/v1/responses/{response_id}/cancel"
                    )
                    self._wait_for(lambda: self._cancel_is_waiting(lock_name))
                    released = self._json(
                        self.model.post(
                            "/stream-rules/release", json={"matchText": self.marker}
                        )
                    )
                    self.assertEqual(released["released"], 1)
                    self._wait_for(lambda: self._terminal_is_waiting(task_id))
                finally:
                    lock.execute(
                        text("SELECT RELEASE_LOCK(:name)"), {"name": lock_name}
                    )
                cancelled = self._json(cancel.result(timeout=5))
            self.assertEqual(cancelled["status"], "completed", cancelled)
            stream.result(timeout=6)
        finally:
            with SessionLocal() as ddl:
                ddl.execute(text(f"DROP TRIGGER {trigger}"))
                ddl.commit()

    def _cancel_is_waiting(self, lock_name: str) -> bool:
        with SessionLocal() as db:
            return bool(
                db.scalar(
                    text(
                        """
                SELECT COUNT(*) FROM performance_schema.metadata_locks
                WHERE OBJECT_TYPE = 'USER LEVEL LOCK' AND LOCK_STATUS = 'PENDING'
                  AND OBJECT_NAME = :name
            """
                    ),
                    {"name": lock_name},
                )
            )

    def _terminal_is_waiting(self, task_id: int) -> bool:
        with SessionLocal() as db:
            return bool(
                db.scalar(
                    text(
                        """
                SELECT COUNT(*)
                FROM performance_schema.data_lock_waits AS waiting
                JOIN performance_schema.data_locks AS requested
                  ON requested.ENGINE_LOCK_ID = waiting.REQUESTING_ENGINE_LOCK_ID
                WHERE requested.OBJECT_NAME = 'tasks'
                  AND requested.LOCK_DATA = :task_id
            """
                    ),
                    {"task_id": str(task_id)},
                )
            )


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
