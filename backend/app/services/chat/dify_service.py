# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Dify Service for Direct API Calls

Supports Dify chatbot, workflow, agent, and chatflow applications.
All operations are fully async for optimal performance with uvicorn workers.

This is an async implementation based on the executor/agents/dify/dify_agent.py
"""

import asyncio
import json
import logging
from typing import Any, AsyncGenerator, Dict, Optional

import httpx

from app.services.chat.base import DirectChatService, http_client_manager
from app.services.chat.session_manager import session_manager

logger = logging.getLogger(__name__)


class DifyService(DirectChatService):
    """
    Direct chat service for Dify API calls.

    Supports:
    - Chat mode
    - Chatflow mode
    - Workflow mode
    - Agent-chat mode
    """

    # Dify task IDs for cancellation (in-memory cache for current requests)
    _dify_task_ids: Dict[int, str] = {}

    async def chat_stream(
        self,
        task_id: int,
        subtask_id: int,
        prompt: str,
        config: Dict[str, Any],
    ) -> AsyncGenerator[str, None]:
        """
        Execute streaming chat with Dify API.

        Args:
            task_id: Task ID for session management
            subtask_id: Subtask ID for status updates
            prompt: User message
            config: Configuration containing:
                - api_key: Dify API key
                - base_url: Dify API base URL
                - app_id: Optional Dify app ID
                - params: Optional workflow/chatflow parameters
                - bot_prompt: Optional JSON containing difyAppId and params

        Yields:
            str: SSE-formatted response chunks
        """
        # Extract configuration
        api_key = config.get("api_key", "")
        base_url = config.get("base_url", "https://api.dify.ai")
        params = config.get("params", {})
        bot_prompt = config.get("bot_prompt", "")

        if not api_key:
            yield self._format_error_event("Dify API key is not configured")
            return

        # Parse bot_prompt for difyAppId and params
        if bot_prompt:
            try:
                prompt_data = json.loads(bot_prompt)
                if prompt_data.get("params"):
                    params.update(prompt_data.get("params", {}))
            except json.JSONDecodeError:
                pass

        # Clear any previous cancellation flag
        await session_manager.clear_cancelled(task_id)

        # Get app mode
        app_mode = await self._get_app_mode(api_key, base_url)

        full_response = ""

        try:
            if app_mode == "workflow":
                async for chunk in self._call_workflow_api(
                    task_id, api_key, base_url, prompt, params
                ):
                    if await session_manager.is_cancelled(task_id):
                        await self._stop_dify_task(task_id, api_key, base_url, is_workflow=True)
                        yield self._format_error_event("Request cancelled by user")
                        return
                    full_response += chunk
                    yield self._format_message_event(chunk)
            else:
                # chat, chatflow, agent-chat, completion
                conversation_id = await session_manager.get_dify_conversation_id(task_id)
                async for chunk in self._call_chat_api(
                    task_id, api_key, base_url, prompt, params, conversation_id
                ):
                    if await session_manager.is_cancelled(task_id):
                        await self._stop_dify_task(task_id, api_key, base_url, is_workflow=False)
                        yield self._format_error_event("Request cancelled by user")
                        return
                    full_response += chunk
                    yield self._format_message_event(chunk)

            yield self._format_done_event(full_response)

        except asyncio.CancelledError:
            logger.info(f"Dify stream cancelled for task {task_id}")
            yield self._format_error_event("Request cancelled")
        except httpx.TimeoutException:
            logger.error(f"Dify API timeout for task {task_id}")
            yield self._format_error_event("API call timeout")
        except httpx.RequestError as e:
            logger.error(f"Network error for task {task_id}: {e}")
            yield self._format_error_event(f"Network error: {str(e)}")
        except Exception as e:
            logger.exception(f"Error in Dify stream for task {task_id}: {e}")
            yield self._format_error_event(str(e))
        finally:
            # Clean up task ID from cache
            self._dify_task_ids.pop(task_id, None)

    async def _get_app_mode(self, api_key: str, base_url: str) -> str:
        """
        Get Dify application mode by calling /v1/info endpoint.

        Args:
            api_key: Dify API key
            base_url: Dify API base URL

        Returns:
            Application mode: "chat", "chatflow", "workflow", "agent-chat", "completion"
        """
        url = f"{base_url.rstrip('/')}/v1/info"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        try:
            client = await http_client_manager.get_client()
            response = await client.get(url, headers=headers, timeout=10.0)
            response.raise_for_status()
            data = response.json()
            return data.get("mode", "chat")
        except Exception as e:
            logger.warning(f"Failed to get Dify app mode, defaulting to 'chat': {e}")
            return "chat"

    async def _call_chat_api(
        self,
        task_id: int,
        api_key: str,
        base_url: str,
        query: str,
        params: Dict[str, Any],
        conversation_id: str,
    ) -> AsyncGenerator[str, None]:
        """
        Call Dify Chat/Chatflow API with streaming.

        Args:
            task_id: Task ID
            api_key: Dify API key
            base_url: Dify API base URL
            query: User message
            params: Input parameters
            conversation_id: Existing conversation ID for multi-turn

        Yields:
            str: Response content chunks
        """
        url = f"{base_url.rstrip('/')}/v1/chat-messages"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "inputs": params,
            "query": query,
            "response_mode": "streaming",
            "user": f"task-{task_id}",
            "auto_generate_name": True,
        }

        if conversation_id:
            payload["conversation_id"] = conversation_id

        client = await http_client_manager.get_client()

        async with client.stream("POST", url, headers=headers, json=payload, timeout=300.0) as response:
            if response.status_code != 200:
                error_text = await response.aread()
                raise Exception(f"Dify API error {response.status_code}: {error_text.decode()}")

            new_conversation_id = ""

            async for line in response.aiter_lines():
                if await session_manager.is_cancelled(task_id):
                    break

                if not line or not line.startswith("data: "):
                    continue

                data_str = line[6:]  # Remove 'data: ' prefix

                try:
                    data = json.loads(data_str)

                    # Store task_id for cancellation
                    if "task_id" in data and task_id not in self._dify_task_ids:
                        self._dify_task_ids[task_id] = data["task_id"]

                    # Extract conversation_id
                    if "conversation_id" in data and not new_conversation_id:
                        new_conversation_id = data["conversation_id"]

                    event = data.get("event", "")
                    if event in ("message", "agent_message"):
                        yield data.get("answer", "")
                    elif event == "error":
                        error_msg = data.get("message", "Unknown error")
                        raise Exception(f"Dify API error: {error_msg}")

                except json.JSONDecodeError:
                    continue

            # Save conversation ID for next message
            if new_conversation_id:
                await session_manager.save_dify_conversation_id(task_id, new_conversation_id)

    async def _call_workflow_api(
        self,
        task_id: int,
        api_key: str,
        base_url: str,
        query: str,
        params: Dict[str, Any],
    ) -> AsyncGenerator[str, None]:
        """
        Call Dify Workflow API with streaming.

        Args:
            task_id: Task ID
            api_key: Dify API key
            base_url: Dify API base URL
            query: User message (added to inputs)
            params: Input parameters

        Yields:
            str: Response content chunks (final output as JSON)
        """
        url = f"{base_url.rstrip('/')}/v1/workflows/run"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        # Combine query with params as inputs
        inputs = dict(params)
        if "query" not in inputs and "user_query" not in inputs:
            inputs["query"] = query

        payload = {
            "inputs": inputs,
            "response_mode": "streaming",
            "user": f"task-{task_id}",
        }

        client = await http_client_manager.get_client()
        result_outputs = {}

        async with client.stream("POST", url, headers=headers, json=payload, timeout=300.0) as response:
            if response.status_code != 200:
                error_text = await response.aread()
                raise Exception(f"Dify Workflow API error {response.status_code}: {error_text.decode()}")

            async for line in response.aiter_lines():
                if await session_manager.is_cancelled(task_id):
                    break

                if not line or not line.startswith("data: "):
                    continue

                data_str = line[6:]  # Remove 'data: ' prefix

                try:
                    data = json.loads(data_str)

                    # Store task_id for cancellation
                    if "task_id" in data and task_id not in self._dify_task_ids:
                        self._dify_task_ids[task_id] = data["task_id"]

                    event = data.get("event", "")
                    if event == "workflow_finished":
                        result_outputs = data.get("data", {}).get("outputs", {})
                    elif event == "error":
                        error_msg = data.get("message", "Unknown error")
                        raise Exception(f"Dify Workflow error: {error_msg}")

                except json.JSONDecodeError:
                    continue

        # Return workflow output as JSON string
        if result_outputs:
            yield json.dumps(result_outputs, ensure_ascii=False, indent=2)

    async def _stop_dify_task(
        self,
        task_id: int,
        api_key: str,
        base_url: str,
        is_workflow: bool = False,
    ) -> bool:
        """
        Stop a running Dify task.

        Args:
            task_id: Task ID
            api_key: Dify API key
            base_url: Dify API base URL
            is_workflow: Whether this is a workflow task

        Returns:
            bool: True if stop was successful
        """
        dify_task_id = self._dify_task_ids.get(task_id)
        if not dify_task_id:
            logger.warning(f"No Dify task_id found for task {task_id}")
            return False

        try:
            if is_workflow:
                url = f"{base_url.rstrip('/')}/v1/workflows/tasks/{dify_task_id}/stop"
            else:
                url = f"{base_url.rstrip('/')}/v1/chat-messages/{dify_task_id}/stop"

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            payload = {"user": f"task-{task_id}"}

            client = await http_client_manager.get_client()
            response = await client.post(url, headers=headers, json=payload, timeout=10.0)
            response.raise_for_status()

            result = response.json()
            if result.get("result") == "success":
                logger.info(f"Successfully stopped Dify task: {dify_task_id}")
                return True
            else:
                logger.warning(f"Dify stop API returned: {result}")
                return False

        except Exception as e:
            logger.warning(f"Failed to stop Dify task {dify_task_id}: {e}")
            return False

    async def cancel(self, task_id: int) -> bool:
        """
        Cancel an ongoing Dify request.

        Args:
            task_id: Task ID to cancel

        Returns:
            bool: True if cancellation flag was set
        """
        logger.info(f"Cancelling Dify request for task {task_id}")
        return await session_manager.set_cancelled(task_id)


# Global service instance
dify_service = DifyService()
