# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real chat WebSocket and MCP HTTP requests, durable jobs and owner isolation."""

import asyncio
import base64
import hashlib
import json
import time
import uuid

import socketio
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from app.core.config import settings
from app.db.session import SessionLocal
from app.models import Subtask, SubtaskContext
from app.models.subtask import SubtaskRole
from app.services.auth.task_token import create_task_token

from .fixture import REPORT


class GenerationCases:
    def references(self, *, legacy: bool = False, foreign: bool = False) -> list[int]:
        ids = []
        for media_type, extension in (("video", "mp4"), ("audio", "wav")):
            response = self.upload(
                f"reference-{uuid.uuid4().hex}.{extension}",
                self.media[media_type],
                token=self.other_jwt if foreign else self.jwt,
            )
            self.assertEqual(response.status_code, 200, response.text)
            attachment_id = response.json()["id"]
            ids.append(attachment_id)
            if legacy:
                # The old provider layout holds only its opaque persistent FID.
                # Its real stored object must still exist and be readable.
                with SessionLocal() as db:
                    row = db.get(SubtaskContext, attachment_id)
                    metadata = dict(row.type_data)
                    metadata["legacy_fid"] = metadata.pop("hosted_media")["media_id"]
                    row.type_data = metadata
                    db.commit()
        return ids

    def chat(self, attachment_ids: list[int]) -> dict:
        return asyncio.run(self.send_chat(attachment_ids))

    async def send_chat(self, attachment_ids: list[int]) -> dict:
        client = socketio.AsyncClient(reconnection=False)
        try:
            await client.connect(
                self.url,
                auth={"token": self.jwt},
                namespaces=["/chat"],
                transports=["websocket"],
            )
            return await client.call(
                "chat:send",
                {
                    "team_id": self.resources["Team"],
                    "message": "Generate a video from the supplied media",
                    "attachment_ids": attachment_ids,
                    "task_type": "video",
                    "enable_deep_thinking": False,
                },
                namespace="/chat",
                timeout=30,
            )
        finally:
            await client.disconnect()

    async def call_tool(
        self, task_id: int, subtask_id: int, attachment_ids: list[int]
    ) -> dict:
        token = create_task_token(task_id, subtask_id, self.user_id, self.user_name)
        async with streamablehttp_client(
            self.url + "/mcp/video/sse", headers={"Authorization": f"Bearer {token}"}
        ) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "generate_video",
                    {
                        "prompt": "Generate a video from the supplied media",
                        "reference_videos": [str(attachment_ids[0])],
                        "reference_audios": [str(attachment_ids[1])],
                    },
                )
                self.assertFalse(result.isError, str(result))
                return json.loads(result.content[0].text)

    def wait_job(self, subtask_id: int) -> dict:
        deadline = time.monotonic() + 30
        while True:
            with SessionLocal() as db:
                subtask = db.get(Subtask, subtask_id)
                result = subtask.result or {}
                job = result.get("video_job") or {}
                if job.get("job_id"):
                    return job
                self.assertNotIn(
                    subtask.status.value, {"FAILED", "ERROR"}, json.dumps(result)
                )
            self.assertLess(
                time.monotonic(), deadline, "Generation job was not persisted"
            )
            time.sleep(0.1)

    def assert_job(self, subtask_id: int, attachment_ids: list[int]) -> dict:
        job = self.wait_job(subtask_id)
        self.assertEqual(job["status"], "polling")
        received = self.model.jobs[job["job_id"]]
        self.assertEqual(
            received["media"],
            [
                {
                    "type": media_type + "_url",
                    "sha256": hashlib.sha256(self.media[media_type]).hexdigest(),
                }
                for media_type in ("video", "audio")
            ],
        )
        self.assertEqual(self.model.failures, [])
        resolutions = [
            json.loads(line)
            for line in (REPORT / "resolution.jsonl").read_text().splitlines()
        ]
        for attachment_id in attachment_ids:
            self.assertTrue(
                any(
                    item["attachment_id"] == attachment_id
                    and item["user_id"] == self.user_id
                    for item in resolutions
                ),
                resolutions,
            )
        self.wait_queued_job(subtask_id, job["job_id"])
        self.evidence.append(
            {
                "case": self._testMethodName,
                "subtask_id": subtask_id,
                "job_id": job["job_id"],
                "attachment_ids": attachment_ids,
                "user_id": self.user_id,
                "model_downloaded_both_media": True,
                "persisted_and_dispatched": True,
            }
        )
        return job

    def wait_queued_job(self, subtask_id: int, job_id: str) -> None:
        # Chat persists before publishing asynchronously. Observe both durable
        # boundaries without repeating the request or replacing its dispatcher.
        deadline = time.monotonic() + 10
        while True:
            messages = [
                json.loads(message)
                for message in self.redis.lrange(
                    settings.CELERY_TASK_DEFAULT_QUEUE, 0, -1
                )
            ]
            queued = [
                json.loads(base64.b64decode(message["body"]))[1]
                for message in messages
                if message["headers"]["task"] == "app.tasks.video_tasks.poll_video_job"
            ]
            if any(
                item["subtask_id"] == subtask_id
                and item["user_id"] == self.user_id
                and item["job_id"] == job_id
                for item in queued
            ):
                return
            self.assertLess(
                time.monotonic(), deadline, "Video polling was not queued in real Redis"
            )
            time.sleep(0.05)

    def test_chat_resolves_hosted_references_without_public_url(self) -> None:
        ids = self.references()
        ack = self.chat(ids)
        self.assertFalse(ack.get("error"), ack)
        self.assert_job(self.chat_assistant_id(ack), ids)

    def test_chat_resolves_legacy_fids_without_public_url(self) -> None:
        ids = self.references(legacy=True)
        ack = self.chat(ids)
        self.assertFalse(ack.get("error"), ack)
        self.assert_job(self.chat_assistant_id(ack), ids)

    def chat_assistant_id(self, ack: dict) -> int:
        # The chat ACK identifies the user's message, not the generated reply.
        with SessionLocal() as db:
            user_subtask = db.get(Subtask, ack["subtask_id"])
            self.assertEqual(user_subtask.role, SubtaskRole.USER)
            return (
                db.query(Subtask)
                .filter_by(task_id=ack["task_id"], role=SubtaskRole.ASSISTANT)
                .one()
                .id
            )

    def test_mcp_resolves_hosted_references_without_public_url(self) -> None:
        self.assert_tool_references(legacy=False)

    def test_mcp_resolves_legacy_fids_without_public_url(self) -> None:
        self.assert_tool_references(legacy=True)

    def assert_tool_references(self, *, legacy: bool) -> None:
        ids = self.references(legacy=legacy)
        task_id, subtask_id = self.new_tool_task()
        result = asyncio.run(self.call_tool(task_id, subtask_id, ids))
        self.assertNotIn("error", result, result)
        job = self.assert_job(subtask_id, ids)
        self.assertEqual(result["job_id"], job["job_id"])
        self.assertTrue(result["persisted"])

    def test_chat_rejects_another_users_attachments(self) -> None:
        ids = self.references(foreign=True)
        jobs_before = set(self.model.jobs)
        ack = self.chat(ids)
        self.assertTrue(ack.get("error"), ack)
        self.assertEqual(set(self.model.jobs), jobs_before)
        with SessionLocal() as db:
            for attachment_id in ids:
                row = db.get(SubtaskContext, attachment_id)
                self.assertEqual(row.user_id, self.other_id)
                self.assertEqual(row.subtask_id, 0)

    def test_mcp_rejects_another_users_attachments(self) -> None:
        ids = self.references(foreign=True)
        jobs_before = set(self.model.jobs)
        task_id, subtask_id = self.new_tool_task()
        result = asyncio.run(self.call_tool(task_id, subtask_id, ids))
        self.assertIn("Reference attachment not found", result.get("error", ""), result)
        self.assertEqual(set(self.model.jobs), jobs_before)
        with SessionLocal() as db:
            self.assertFalse(
                (db.get(Subtask, subtask_id).result or {}).get("video_job")
            )
