# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify Docker callback renewal through the real Manager, Executor and Backend."""

import json
import os
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from uuid import uuid4

import httpx
from redis import Redis

from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User


@contextmanager
def task_fixture() -> Iterator[tuple[str, int, list[int]]]:
    marker = f"docker-lease-{uuid4().hex}"
    with SessionLocal() as db:
        user = User(user_name=marker, password_hash="", is_active=True)
        db.add(user)
        db.flush()
        task = TaskResource(
            user_id=user.id,
            kind="Task",
            name=marker,
            json={
                "kind": "Task",
                "metadata": {"name": marker, "namespace": "default"},
                "spec": {"title": marker},
                "status": {"status": "RUNNING"},
            },
        )
        db.add(task)
        db.flush()
        turns = [
            Subtask(
                user_id=user.id,
                task_id=task.id,
                team_id=0,
                title=marker,
                bot_ids=[],
                role=SubtaskRole.ASSISTANT,
                status=SubtaskStatus.RUNNING,
                message_id=message_id,
            )
            for message_id in (1, 2, 3)
        ]
        db.add_all(turns)
        db.flush()
        user_id, task_id, turn_ids = user.id, task.id, [turn.id for turn in turns]
        db.commit()

    try:
        yield marker, task_id, turn_ids
    finally:
        with SessionLocal() as db:
            for model in (Subtask, TaskResource):
                db.query(model).filter_by(user_id=user_id).delete()
            db.query(User).filter_by(id=user_id).delete()
            db.commit()


def wait_for(description: str, predicate: Callable[[], bool], timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(f"Timed out waiting for {description}")
        time.sleep(min(0.25, remaining))


def container_id(name: str) -> str:
    identity, running = subprocess.check_output(
        ["docker", "inspect", "--format", "{{.Id}} {{.State.Running}}", name],
        text=True,
        timeout=5,
    ).split()
    assert running == "true", f"Executor container {name} is no longer running"
    return identity


def dispatch_and_verify(
    client: httpx.Client,
    task_id: int,
    subtask_id: int,
    executor_name: str,
    user_name: str,
) -> None:
    # Run a real CLI dependency check in the Executor with a distinct turn marker.
    # Its structured result goes through the normal authenticated callback, then
    # the Backend commits it to the assistant subtask.
    marker = f"lease-turn-{subtask_id}"
    queued = client.post(
        "/v1/responses",
        json={
            "model": "ImageValidator",
            "input": marker,
            "background": True,
            "stream": False,
            "metadata": {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "type": "online",
                "user": {"name": user_name},
                "executor_name": executor_name,
                "bot": [{"shell_type": "ImageValidator"}],
                "validation_params": {"shell_type": "Agno", "shell_name": marker},
            },
        },
    ).raise_for_status()
    assert queued.json()["status"] == "queued"

    def completed() -> bool:
        with SessionLocal() as db:
            turn = db.get(Subtask, subtask_id)
            assert turn is not None
            assert turn.status not in (
                SubtaskStatus.FAILED,
                SubtaskStatus.CANCELLED,
            ), f"Turn {subtask_id} finished as {turn.status.value}: {turn.error_message}"
            if turn.status != SubtaskStatus.COMPLETED:
                return False
            result = json.loads(turn.result["value"])
            assert result["shell_name"] == marker
            assert [check["name"] for check in result["checks"]] == ["python", "sqlite"]
            assert turn.executor_name == executor_name
            return True

    wait_for(f"Executor callback persisted for turn {subtask_id}", completed, 20)


def prepare_executor(
    client: httpx.Client,
    task_id: int,
    subtask_id: int,
    user_name: str,
    image: str,
    name: str | None = None,
) -> str:
    prepared = (
        client.post(
            "/executors/prepare",
            timeout=60,
            json={
                "task_id": task_id,
                "subtask_id": subtask_id,
                "user": {"name": user_name},
                "executor_type": "docker",
                "executor_image": image,
                "executor_name": name,
            },
        )
        .raise_for_status()
        .json()
    )
    assert prepared["status"] == "success", prepared
    return prepared["executor_name"]


def delete_executor(client: httpx.Client, name: str) -> None:
    response = client.post(
        "/executor/delete", json={"executor_name": name}, timeout=20
    ).raise_for_status()
    assert response.json()["status"] == "success"


def verify_callback_lease(
    client: httpx.Client, redis: Redis, ttl: int, image: str
) -> None:
    with task_fixture() as (
        user_name,
        task_id,
        (first_turn, next_turn, replacement_turn),
    ):
        name = prepare_executor(client, task_id, first_turn, user_name, image)
        replacement = None
        original_deleted = False
        try:
            # With no renewals, any binding provisioned by prepare must be absent
            # by this conservative deadline.
            original_deadline = time.monotonic() + ttl
            initial_container = container_id(name)
            key = f"task_executor:{task_id}"
            with redis.pipeline() as pipe:
                binding, remaining_ms = pipe.get(key).pttl(key).execute()
            assert binding and 0 < remaining_ms <= ttl * 1000
            initial_token = json.loads(binding)["callback_token"]
            assert initial_token, "Prepared runtime has no callback credential"

            dispatch_and_verify(client, task_id, first_turn, name, user_name)
            wait_for(
                "original callback credential TTL to elapse",
                lambda: time.monotonic() >= original_deadline,
                ttl + 1,
            )
            with redis.pipeline() as pipe:
                binding, remaining_ms = pipe.get(key).pttl(key).execute()
            assert binding and remaining_ms > 0, "Active Docker binding expired"
            current = json.loads(binding)
            assert current["executor_name"] == name
            assert (
                current["callback_token"] == initial_token
            ), "Lease replaced the token"
            assert container_id(name) == initial_container

            dispatch_and_verify(client, task_id, next_turn, name, user_name)
            assert container_id(name) == initial_container
            print("Docker callback and next dispatch succeeded past the original TTL")

            replacement = prepare_executor(
                client, task_id, replacement_turn, user_name, image, f"{name}-next"
            )
            assert replacement != name
            binding = redis.get(key)
            assert binding, "Replacement runtime has no callback lease"
            current = json.loads(binding)
            assert current["executor_name"] == replacement
            assert (
                current["callback_token"] != initial_token
            ), "Replacement reused the old token"

            delete_executor(client, name)
            original_deleted = True
            dispatch_and_verify(
                client, task_id, replacement_turn, replacement, user_name
            )
            print(
                "Replacement Docker Executor dispatched and called back after old runtime cleanup"
            )
        finally:
            try:
                if not original_deleted:
                    delete_executor(client, name)
            finally:
                if replacement:
                    delete_executor(client, replacement)


def main() -> None:
    manager = os.environ.get("E2E_EXECUTOR_MANAGER_URL", "http://localhost:8001")
    image = os.environ.get(
        "E2E_REMOTE_WORKSPACE_EXECUTOR_IMAGE", "wegent/e2e-workspace-executor:latest"
    )
    with (
        httpx.Client(
            base_url=f"{manager}/executor-manager",
            headers={
                "Authorization": f"Bearer {os.environ['E2E_INTERNAL_SERVICE_TOKEN']}"
            },
            timeout=5,
        ) as client,
        Redis.from_url(os.environ["REDIS_URL"]) as redis,
    ):
        verify_callback_lease(
            client, redis, int(os.environ["SANDBOX_EXECUTOR_BINDING_TTL"]), image
        )


if __name__ == "__main__":
    main()
