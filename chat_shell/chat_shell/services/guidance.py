# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Guidance queue integration for Chat Shell model calls."""

import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Protocol

import httpx
from langchain_core.messages import HumanMessage

from chat_shell.core.config import settings

logger = logging.getLogger(__name__)

GUIDANCE_MESSAGE_TEMPLATE = (
    "[Runtime guidance from the user]\n"
    "Use this as an in-progress instruction for the current run. "
    "Do not treat it as a normal chat message to display.\n\n"
    "{message}"
)


@dataclass(frozen=True)
class GuidanceItem:
    """Guidance queue item consumed before a model call."""

    guidance_id: str
    message: str


class GuidanceQueue(Protocol):
    """Queue interface used by GuidanceConsumer."""

    async def consume(self, task_id: int, subtask_id: int) -> GuidanceItem | None:
        """Consume one pending guidance item, if any."""

    async def expire(self, task_id: int, subtask_id: int) -> None:
        """Expire pending guidance items for this execution."""


class RemoteGuidanceQueueClient:
    """HTTP client for Backend's internal guidance queue API."""

    def __init__(
        self,
        base_url: str,
        auth_token: str = "",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Return a shared HTTP client for guidance queue requests."""
        if self._client is None:
            headers = {
                "X-Service-Name": "chat-shell",
                "Content-Type": "application/json",
            }
            if self.auth_token:
                headers["Authorization"] = f"Bearer {self.auth_token}"
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers=headers,
                timeout=self.timeout,
            )
        return self._client

    async def consume(self, task_id: int, subtask_id: int) -> GuidanceItem | None:
        """Consume one pending guidance item from Backend."""
        client = await self._get_client()
        response = await client.post(f"/chat/guidance/{task_id}/{subtask_id}/consume")
        response.raise_for_status()
        data = response.json()
        item_data = data.get("item") if isinstance(data, dict) else None
        if item_data is None and isinstance(data, dict):
            item_data = data
        if not item_data:
            return None

        guidance_id = str(item_data.get("guidance_id") or "")
        message = str(item_data.get("message") or "")
        if not guidance_id or not message:
            logger.warning(
                "[GuidanceQueue] Ignoring invalid guidance item: task_id=%s subtask_id=%s item_data=%s",
                task_id,
                subtask_id,
                item_data,
            )
            return None
        return GuidanceItem(guidance_id=guidance_id, message=message)

    async def expire(self, task_id: int, subtask_id: int) -> None:
        """Expire pending guidance items in Backend."""
        client = await self._get_client()
        response = await client.post(f"/chat/guidance/{task_id}/{subtask_id}/expire")
        response.raise_for_status()


class PackageGuidanceQueueClient:
    """Package-mode adapter for Backend's in-process guidance queue service."""

    def __init__(self, service: Any) -> None:
        self.service = service

    async def consume(self, task_id: int, subtask_id: int) -> GuidanceItem | None:
        """Consume one pending guidance item from the in-process Backend service."""
        result = await self.service.consume(task_id=task_id, subtask_id=subtask_id)
        if not result:
            return None
        if isinstance(result, dict):
            guidance_id = str(result.get("guidance_id") or "")
            message = str(result.get("message") or "")
        else:
            guidance_id = str(getattr(result, "guidance_id", "") or "")
            message = str(getattr(result, "message", "") or "")
        if not guidance_id or not message:
            return None
        return GuidanceItem(guidance_id=guidance_id, message=message)

    async def expire(self, task_id: int, subtask_id: int) -> None:
        """Expire pending guidance items in the in-process Backend service."""
        await self.service.expire(task_id=task_id, subtask_id=subtask_id)


class GuidanceConsumer:
    """Consumes one guidance item before model invocation."""

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        queue: GuidanceQueue,
        emitter: Any,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> None:
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.queue = queue
        self.emitter = emitter
        self.is_cancelled = is_cancelled or (lambda: False)
        self._expire_attempted = False

    def create_pre_model_hook(self) -> Callable[[dict[str, Any]], Any]:
        """Create a LangGraph pre_model_hook that injects one guidance message per model loop."""

        async def pre_model_hook(state: dict[str, Any]) -> dict[str, Any]:
            messages = list(state.get("messages") or [])
            if self.is_cancelled():
                return {"llm_input_messages": messages}

            logger.info(
                "[GuidanceConsumer] pre_model_hook consuming: task_id=%s subtask_id=%s",
                self.task_id,
                self.subtask_id,
            )
            try:
                item = await self.queue.consume(self.task_id, self.subtask_id)
            except Exception:
                logger.warning(
                    "[GuidanceConsumer] Failed to consume guidance: task_id=%s subtask_id=%s",
                    self.task_id,
                    self.subtask_id,
                    exc_info=True,
                )
                return {"llm_input_messages": messages}

            if not item:
                logger.info(
                    "[GuidanceConsumer] no guidance in queue: task_id=%s subtask_id=%s",
                    self.task_id,
                    self.subtask_id,
                )
                return {"llm_input_messages": messages}

            logger.info(
                "[GuidanceConsumer] consumed guidance: task_id=%s subtask_id=%s guidance_id=%s",
                self.task_id,
                self.subtask_id,
                item.guidance_id,
            )
            block = self._build_guidance_block(item)
            await self._emit_guidance_block(block)
            guidance_message = HumanMessage(
                content=GUIDANCE_MESSAGE_TEMPLATE.format(message=item.message)
            )
            return {"llm_input_messages": [*messages, guidance_message]}

        return pre_model_hook

    async def expire_pending(self) -> None:
        """Expire pending guidance items before execution leaves the active loop."""
        if self._expire_attempted:
            return
        self._expire_attempted = True
        try:
            await self.queue.expire(self.task_id, self.subtask_id)
        except Exception:
            logger.warning(
                "[GuidanceConsumer] Failed to expire guidance: task_id=%s subtask_id=%s",
                self.task_id,
                self.subtask_id,
                exc_info=True,
            )

    def _build_guidance_block(self, item: GuidanceItem) -> dict[str, Any]:
        """Build the UI block emitted when guidance is applied."""
        now = datetime.now(timezone.utc)
        return {
            "id": f"guidance-{item.guidance_id or uuid.uuid4().hex}",
            "type": "guidance",
            "guidance_id": item.guidance_id,
            "content": item.message,
            "status": "done",
            "timestamp": int(time.time() * 1000),
            "applied_at": now.isoformat().replace("+00:00", "Z"),
        }

    async def _emit_guidance_block(self, block: dict[str, Any]) -> None:
        """Emit a guidance block through the available emitter API."""
        block_created = getattr(self.emitter, "block_created", None)
        if block_created is not None:
            await block_created(block)
            return

        emit = getattr(self.emitter, "_emit", None)
        if emit is not None:
            await emit("chat:block_created", {"block": block})


def create_guidance_queue_client() -> GuidanceQueue:
    """Create the best available guidance queue client for the current mode."""
    if settings.MODE == "package":
        try:
            from app.services.chat.guidance_queue import guidance_queue  # type: ignore

            return PackageGuidanceQueueClient(guidance_queue)
        except Exception:
            logger.info(
                "[GuidanceQueue] Falling back to remote guidance queue client",
                exc_info=True,
            )

    return RemoteGuidanceQueueClient(
        base_url=settings.REMOTE_STORAGE_URL,
        auth_token=settings.REMOTE_STORAGE_TOKEN or settings.INTERNAL_SERVICE_TOKEN,
    )
