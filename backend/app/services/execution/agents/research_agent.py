# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Research agent for Gemini Deep Research.

Handles deep research tasks which require:
1. Create a background research job
2. Poll for completion while streaming thinking progress
3. Stream the final report on completion

Calls the Gemini Interaction API directly via GeminiInteractionClient.
"""

import asyncio
import json
import logging
from typing import Any

from shared.clients.gemini_interaction import (
    GeminiInteractionClient,
    GeminiInteractionError,
)
from shared.models import (
    EventType,
    ExecutionEvent,
    ExecutionRequest,
)

from ..emitters import ResultEmitter
from .base import PollingAgent

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 5
MAX_POLL_COUNT = 720  # 1 hour at 5s intervals
DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
DEFAULT_DEEP_RESEARCH_AGENT = "deep-research-pro-preview-12-2025"
THOUGHT_STREAM_TIMEOUT = 30.0  # seconds, timeout per read for thinking progress
REPORT_STREAM_TIMEOUT = 300.0  # seconds, timeout per read for final report


class ResearchAgent(PollingAgent):
    """Gemini Deep Research agent.

    Handles deep research tasks by creating a job, polling for progress,
    and streaming the final report.
    """

    @property
    def name(self) -> str:
        return "ResearchAgent"

    async def execute(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """Execute deep research task.

        Args:
            request: Execution request
            emitter: Result emitter for event emission
        """
        from app.services.chat.storage.session import session_manager

        cancel_event = await session_manager.register_stream(request.subtask_id)

        task_id = request.task_id
        subtask_id = request.subtask_id
        message_id = request.message_id

        # Send START event
        await emitter.emit_start(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            data={"shell_type": "Chat"},
        )

        model_config = request.model_config or {}
        gemini_base_url = model_config.get("base_url") or DEFAULT_GEMINI_BASE_URL
        agent = model_config.get("model_id", DEFAULT_DEEP_RESEARCH_AGENT)

        gemini_client = GeminiInteractionClient(
            base_url=gemini_base_url,
            api_key=model_config.get("api_key", ""),
            default_headers=model_config.get("default_headers", {}),
        )

        offset = 0

        try:
            # Step 1: Create deep research job
            input_text = (
                request.prompt
                if isinstance(request.prompt, str)
                else str(request.prompt)
            )
            logger.info(
                f"[{self.name}] Creating job: "
                f"task_id={task_id}, subtask_id={subtask_id}"
            )

            try:
                result = await gemini_client.create_interaction(
                    input_text=input_text,
                    agent=agent,
                )
            except GeminiInteractionError as e:
                raise Exception(f"Failed to create deep research job: {e}") from e

            job_id = result.get("id")
            if not job_id:
                raise Exception(f"No interaction id returned: {result}")

            logger.info(
                f"[{self.name}] Job created: job_id={job_id}, task_id={task_id}"
            )

            # Step 2: Poll for completion, emit thinking progress
            for poll_num in range(1, MAX_POLL_COUNT + 1):
                # Check cancellation
                if cancel_event.is_set() or await session_manager.is_cancelled(
                    subtask_id
                ):
                    logger.info(
                        f"[{self.name}] Cancelled: "
                        f"task_id={task_id}, subtask_id={subtask_id}"
                    )
                    await emitter.emit(
                        ExecutionEvent(
                            type=EventType.CANCELLED,
                            task_id=task_id,
                            subtask_id=subtask_id,
                            message_id=message_id,
                        )
                    )
                    return

                # Check status
                try:
                    status_result = await gemini_client.get_interaction_status(job_id)
                except GeminiInteractionError:
                    logger.warning(f"[{self.name}] Status check failed, retrying...")
                    await asyncio.sleep(POLL_INTERVAL_SECONDS)
                    continue

                status = status_result.get("status", "in_progress")

                if status == "completed":
                    logger.info(f"[{self.name}] Job completed: job_id={job_id}")
                    break
                elif status == "failed":
                    raise Exception(
                        status_result.get("error", "Deep research job failed")
                    )

                # Fetch thinking progress from stream
                thinking_steps = await self._fetch_thought_summaries(
                    gemini_client, job_id
                )
                if thinking_steps:
                    await emitter.emit(
                        ExecutionEvent(
                            type=EventType.CHUNK,
                            task_id=task_id,
                            subtask_id=subtask_id,
                            content="",
                            offset=offset,
                            result={
                                "shell_type": "Chat",
                                "thinking": thinking_steps,
                            },
                            message_id=message_id,
                        )
                    )

                await asyncio.sleep(POLL_INTERVAL_SECONDS)
            else:
                raise Exception("Deep research job timed out after 1 hour")

            # Step 3: Clear thinking and stream final report
            await emitter.emit(
                ExecutionEvent(
                    type=EventType.CHUNK,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content="",
                    offset=offset,
                    result={"shell_type": "Chat", "thinking": []},
                    message_id=message_id,
                )
            )

            full_content, annotations = await self._stream_final_report(
                gemini_client, job_id
            )

            if full_content:
                await emitter.emit(
                    ExecutionEvent(
                        type=EventType.CHUNK,
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=full_content,
                        offset=offset,
                        message_id=message_id,
                    )
                )
                offset += len(full_content)

            # Emit DONE
            result_data: dict[str, Any] = {"value": full_content}
            if annotations:
                result_data["annotations"] = annotations
            await emitter.emit(
                ExecutionEvent(
                    type=EventType.DONE,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    result=result_data,
                    message_id=message_id,
                )
            )

            logger.info(
                f"[{self.name}] Completed: task_id={task_id}, "
                f"subtask_id={subtask_id}, content_length={len(full_content)}"
            )

        finally:
            await session_manager.unregister_stream(subtask_id)

    async def _fetch_thought_summaries(
        self,
        gemini_client: GeminiInteractionClient,
        interaction_id: str,
    ) -> list[dict]:
        """Fetch thought summaries from deep research stream.

        Streams from the Gemini Interaction API directly and parses
        thought_summary events from the content.delta stream.

        Returns thinking steps parsed from thought_summary events.
        """
        thought_summaries: list = []
        try:
            async for (
                event_type,
                event_data_str,
            ) in gemini_client.stream_interaction_result(
                interaction_id, stream_timeout=THOUGHT_STREAM_TIMEOUT
            ):
                try:
                    data = json.loads(event_data_str)
                except json.JSONDecodeError:
                    continue

                gemini_event = data.get("event_type", event_type)
                index = data.get("index")

                if gemini_event == "content.delta" and index == 0:
                    delta = data.get("delta", {})
                    if delta.get("type") == "text":
                        # No thinking format: index=0 is the report, not thoughts
                        return thought_summaries
                    if delta.get("type") == "thought_summary":
                        text = delta.get("content", {}).get("text", "")
                        if text:
                            clean = text.strip()
                            for prefix in ("```json", "```"):
                                if clean.startswith(prefix):
                                    clean = clean[len(prefix) :]
                            if clean.endswith("```"):
                                clean = clean[:-3]
                            clean = clean.strip()
                            try:
                                summaries = json.loads(clean)
                                if isinstance(summaries, list):
                                    thought_summaries = [
                                        {
                                            "title": item.get(
                                                "title", "Research Progress"
                                            ),
                                            "next_action": "continue",
                                            "details": {
                                                "type": "text",
                                                "text": item.get("content", ""),
                                            },
                                        }
                                        for item in summaries
                                    ]
                            except json.JSONDecodeError:
                                pass

                elif gemini_event == "content.start" and index == 1:
                    return thought_summaries

        except GeminiInteractionError:
            pass
        except Exception as e:
            logger.warning(f"[{self.name}] Thought fetch error: {e}")
        return thought_summaries

    async def _stream_final_report(
        self,
        gemini_client: GeminiInteractionClient,
        interaction_id: str,
    ) -> tuple[str, list[dict]]:
        """Stream the final report from deep research results.

        Streams from the Gemini Interaction API directly and collects
        content text and annotations from content.delta events.

        Returns:
            Tuple of (content, annotations).
        """
        full_content = ""
        all_annotations: list[dict] = []
        try:
            async for (
                event_type,
                event_data_str,
            ) in gemini_client.stream_interaction_result(
                interaction_id, stream_timeout=REPORT_STREAM_TIMEOUT
            ):
                try:
                    data = json.loads(event_data_str)
                except json.JSONDecodeError:
                    continue

                gemini_event = data.get("event_type", event_type)
                index = data.get("index")

                if gemini_event == "content.delta":
                    delta = data.get("delta", {})
                    # With thinking: report at index=1
                    # Without thinking: report at index=0, delta.type="text"
                    if index == 1 or (index == 0 and delta.get("type") == "text"):
                        text = delta.get("text", "")
                        if text:
                            full_content += text
                        annotations = delta.get("annotations", [])
                        if annotations:
                            all_annotations.extend(annotations)

        except Exception as e:
            logger.error(f"[{self.name}] Final report error: {e}")
            raise

        return full_content, all_annotations
