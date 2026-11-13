# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise real image execution through the public Socket.IO transport."""

import asyncio
import time

import socketio

from app.db.session import SessionLocal
from app.models import Kind, Subtask


class ImageCases:
    def test_chat_send_and_retry_store_generated_images(self) -> None:
        asyncio.run(self._send_and_retry_images(self._create_image_team()))

    def test_chat_retries_image_immediately_after_cancellation(self) -> None:
        asyncio.run(self._cancel_and_retry_image(self._create_image_team("cancel")))

    def _create_image_team(self, scenario: str = "generate") -> int:
        name = f"{self.suffix}-image-{scenario}"
        specs = {
            "Model": {
                "modelType": "image",
                "protocol": "gpt-image",
                "modelConfig": {
                    "env": {
                        "model": "gpt-image",
                        "model_id": "gpt-image-e2e",
                        "base_url": f"http://127.0.0.1:{self.model.server_port}/v1",
                        "api_key": "",
                    }
                },
                "imageConfig": {"output_format": "png", "size": "1024x1024"},
            },
            "Bot": {
                "ghostRef": {"name": self.suffix},
                "shellRef": {"name": self.suffix},
                "modelRef": {"name": name},
            },
            "Team": {
                "collaborationModel": "solo",
                "members": [{"botRef": {"name": name}}],
                "requiresWorkspace": False,
                "bind_mode": ["image"],
            },
        }
        with SessionLocal() as db:
            for kind, spec in specs.items():
                resource = Kind(
                    kind=kind,
                    name=name,
                    namespace="default",
                    user_id=self.user_id,
                    is_active=True,
                    json={
                        "apiVersion": "agent.wecode.io/v1",
                        "kind": kind,
                        "metadata": {"name": name, "namespace": "default"},
                        "spec": spec,
                    },
                )
                db.add(resource)
            db.flush()
            team_id = resource.id
            db.commit()
        return team_id

    async def _send_and_retry_images(self, team_id: int) -> None:
        client = socketio.AsyncClient(reconnection=False)
        done: asyncio.Queue[dict] = asyncio.Queue()
        errors: asyncio.Queue[dict] = asyncio.Queue()
        client.on("chat:done", handler=done.put_nowait, namespace="/chat")
        client.on("chat:error", handler=errors.put_nowait, namespace="/chat")
        try:
            await client.connect(
                self.url,
                auth={"token": self.jwt},
                namespaces=["/chat"],
                transports=["websocket"],
            )
            first = await self._send_image(client, team_id, "Draw a blue square")
            first_id = self.chat_assistant_id(first)
            await self._assert_completed_image(first_id, done)

            selected_size = "1536x1024"
            second = await self._send_image(
                client, team_id, "Retry the blue square", size=selected_size
            )
            retry_id = self.chat_assistant_id(second)
            with SessionLocal() as db:
                user_subtask = db.get(Subtask, second["subtask_id"])
                self.assertEqual(
                    user_subtask.result["image_config"]["size"], selected_size
                )
            failed = await self._wait_image_turn(retry_id)
            self.assertEqual(failed.status.value, "FAILED")
            self.assertIn("Image model test failure", failed.error_message)
            error_event = await asyncio.wait_for(errors.get(), timeout=10)
            self.assertEqual(error_event["subtask_id"], retry_id)
            retry = await client.call(
                "chat:retry",
                {"task_id": second["task_id"], "subtask_id": retry_id},
                namespace="/chat",
                timeout=15,
            )
            self.assertTrue(retry.get("success"), retry)
            await self._assert_completed_image(retry_id, done)
        finally:
            await client.disconnect()
        self.assertEqual(
            [
                request
                for request in self.model.image_requests
                if request[0] != "Cancel the blue square"
            ],
            [
                ("Draw a blue square", "1024x1024"),
                ("Retry the blue square", selected_size),
                ("Retry the blue square", selected_size),
            ],
        )

    async def _cancel_and_retry_image(self, team_id: int) -> None:
        client = socketio.AsyncClient(reconnection=False)
        cancelled: asyncio.Queue[dict] = asyncio.Queue()
        done: asyncio.Queue[dict] = asyncio.Queue()
        client.on("chat:cancelled", handler=cancelled.put_nowait, namespace="/chat")
        client.on("chat:done", handler=done.put_nowait, namespace="/chat")
        prompt = "Cancel the blue square"
        try:
            await client.connect(
                self.url,
                auth={"token": self.jwt},
                namespaces=["/chat"],
                transports=["websocket"],
            )
            ack = await self._send_image(client, team_id, prompt)
            subtask_id = self.chat_assistant_id(ack)
            self.assertTrue(
                await asyncio.to_thread(self.model.image_request_blocked.wait, 10),
                "The provider never received the first image attempt",
            )
            cancel = await client.call(
                "chat:cancel", {"subtask_id": subtask_id}, namespace="/chat", timeout=10
            )
            self.assertTrue(cancel.get("success"), cancel)
            event = await asyncio.wait_for(cancelled.get(), timeout=10)
            self.assertEqual(event["subtask_id"], subtask_id)
            self.assertIsNone(self.redis.get(f"chat:cancel:{subtask_id}"))
            retry = await client.call(
                "chat:retry",
                {"task_id": ack["task_id"], "subtask_id": subtask_id},
                namespace="/chat",
                timeout=15,
            )
            self.assertTrue(retry.get("success"), retry)
            await self._assert_completed_image(subtask_id, done)
            self.assertEqual(self.model.image_requests.count((prompt, "1024x1024")), 2)
        finally:
            self.model.release_image_request.set()
            await client.disconnect()

    async def _send_image(
        self, client, team_id: int, prompt: str, *, size: str | None = None
    ) -> dict:
        payload: dict = {"team_id": team_id, "task_type": "image", "message": prompt}
        if size is not None:
            payload["generate_params"] = {"size": size}
        ack = await client.call(
            "chat:send",
            payload,
            namespace="/chat",
            timeout=15,
        )
        self.assertFalse(ack.get("error"), ack)
        return ack

    async def _wait_image_turn(self, subtask_id: int) -> Subtask:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            with SessionLocal() as db:
                subtask = db.get(Subtask, subtask_id)
                if subtask.status.value in {"COMPLETED", "FAILED", "CANCELLED"}:
                    db.expunge(subtask)
                    return subtask
            await asyncio.sleep(0.05)
        self.fail(f"Image turn {subtask_id} did not finish")

    async def _assert_completed_image(
        self, subtask_id: int, done: asyncio.Queue[dict]
    ) -> None:
        subtask = await self._wait_image_turn(subtask_id)
        self.assertEqual(subtask.status.value, "COMPLETED", subtask.error_message)
        (block,) = [
            block for block in subtask.result["blocks"] if block["type"] == "image"
        ]
        self.assertEqual(block["status"], "done")
        self.assertTrue(block["image_download_urls"])
        (attachment_id,) = block["image_attachment_ids"]
        event = await asyncio.wait_for(done.get(), timeout=10)
        self.assertEqual(event["subtask_id"], subtask_id)
        self.assertIn(block, event["result"]["blocks"])
        attachment = self.attachment(attachment_id)
        self.assertEqual(attachment.user_id, self.user_id)
        self.assertEqual(attachment.subtask_id, subtask_id)
        stored = self.store.get_object(self.bucket, attachment.storage_key)
        try:
            self.assertEqual(stored.read(), self.model.image)
        finally:
            stored.close()
            stored.release_conn()
