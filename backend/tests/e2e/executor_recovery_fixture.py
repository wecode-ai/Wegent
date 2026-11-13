# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gate real Executor Manager responses and inject faults into CI services."""

import asyncio
import hmac
import io
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Literal

import httpx
import pymysql
from fastapi import FastAPI, Header, HTTPException, Request, Response
from minio import Minio

MANAGER_URL = "http://127.0.0.1:8001"
MANAGER_PREFIX = "/executor-manager"
ARCHIVE_BUCKET = "wegent-archives"


@dataclass
class Recovery:
    hold_restore: bool
    release: asyncio.Event = field(default_factory=asyncio.Event)
    prepare: dict | None = None
    restore: dict | None = None
    delete: dict | None = None


recoveries: dict[int, Recovery] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(base_url=MANAGER_URL, timeout=180) as client:
        app.state.manager = client
        yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.put("/fixture/{task_id}/{mode}")
async def configure(
    task_id: int,
    mode: Literal["prepare", "restore", "cancel", "binding"],
    authorization: str = Header(default=""),
) -> dict:
    authorize(authorization)
    if mode in {"restore", "cancel"}:
        await asyncio.to_thread(corrupt_archive, task_id)
    recoveries[task_id] = Recovery(hold_restore=mode in {"cancel", "binding"})
    return {}


@app.post("/fixture/{task_id}/change-binding/{subtask_id}")
def change_binding(
    task_id: int, subtask_id: int, authorization: str = Header(default="")
) -> dict:
    authorize(authorization)
    with pymysql.connect(
        host="127.0.0.1",
        user="root",
        password=os.environ["E2E_MYSQL_PASSWORD"],
        database="wegent_test",
        autocommit=True,
    ) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE subtasks SET executor_namespace = %s "
                "WHERE id = %s AND task_id = %s AND status = 'PENDING'",
                ("e2e-concurrent-binding", subtask_id, task_id),
            )
            if cursor.rowcount != 1:
                raise HTTPException(409, "Expected one pending subtask")
    return {}


@app.post("/fixture/{task_id}/release")
async def release(task_id: int, authorization: str = Header(default="")) -> dict:
    authorize(authorization)
    recoveries[task_id].release.set()
    return {}


@app.get("/fixture/{task_id}")
async def inspect(task_id: int, authorization: str = Header(default="")) -> dict:
    authorize(authorization)
    recovery = recoveries[task_id]
    return {
        "prepare": recovery.prepare,
        "restore": recovery.restore,
        "delete": recovery.delete,
    }


@app.get("/fixture/{task_id}/containers")
async def containers(task_id: int, authorization: str = Header(default="")) -> dict:
    authorize(authorization)
    process = await asyncio.create_subprocess_exec(
        "docker",
        "ps",
        "-a",
        "--filter",
        f"label=task_id={task_id}",
        "--format",
        "{{.Names}}",
        stdout=asyncio.subprocess.PIPE,
    )
    stdout, _ = await process.communicate()
    if process.returncode != 0:
        raise HTTPException(500, "Could not list executor containers")
    return {"names": stdout.decode().splitlines()}


@app.api_route(
    f"{MANAGER_PREFIX}/{{path:path}}", methods=["GET", "POST", "PUT", "DELETE"]
)
async def forward(path: str, request: Request) -> Response:
    body = await request.body()
    response = await app.state.manager.request(
        request.method,
        f"{MANAGER_PREFIX}/{path}",
        params=request.query_params,
        content=body,
        headers={
            name: value
            for name, value in request.headers.items()
            if name not in {"host", "content-length", "transfer-encoding"}
        },
    )
    if path in {"executors/prepare", "executor/restore", "executor/delete"}:
        payload = await request.json()
        recovery = recoveries.get(payload.get("task_id"))
        if recovery and path == "executors/prepare":
            recovery.prepare = observation(response)
        elif recovery and path == "executor/restore":
            recovery.restore = observation(response)
            if recovery.hold_restore:
                await asyncio.wait_for(recovery.release.wait(), timeout=60)
        elif path == "executor/delete":
            for recovery in recoveries.values():
                prepared = (recovery.prepare or {}).get("body", {})
                if prepared.get("executor_name") == payload.get("executor_name"):
                    recovery.delete = observation(response)
                    break
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type"),
    )


def observation(response: httpx.Response) -> dict:
    return {"status": response.status_code, "body": response.json()}


def authorize(authorization: str) -> None:
    token = os.environ["INTERNAL_SERVICE_TOKEN"]
    if not hmac.compare_digest(authorization, f"Bearer {token}"):
        raise HTTPException(403)


def corrupt_archive(task_id: int) -> None:
    storage = Minio(
        "127.0.0.1:9000",
        access_key=os.environ["ATTACHMENT_S3_ACCESS_KEY"],
        secret_key=os.environ["ATTACHMENT_S3_SECRET_KEY"],
        secure=False,
    )
    path = f"workspace-archives/{task_id}/archive.tar.gz"
    storage.stat_object(ARCHIVE_BUCKET, path)
    invalid_archive = b"Not a gzip archive"
    storage.put_object(
        ARCHIVE_BUCKET, path, io.BytesIO(invalid_archive), len(invalid_archive)
    )
