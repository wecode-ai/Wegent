# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Dify Direct Service.

Provides direct chat functionality for the Dify shell type,
supporting chat, chatflow, workflow, and agent-chat modes.
Adapted from executor/agents/dify/dify_agent.py for async execution.
"""

import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional

from app.services.direct_chat.base import DirectChatService, get_http_client
from app.services.direct_chat.session_manager import SessionManager

logger = logging.getLogger(__name__)


class DifyDirectService(DirectChatService):
    """
    Direct chat service for Dify shell type.

    Supports Dify chatbot, workflow, agent, and chatflow applications.
    Acts as a lightweight proxy to Dify's external API service.
    """

    def __init__(self, task_id: int, subtask_id: int, user_id: int):
        """
        Initialize the Dify direct service.

        Args:
            task_id: The task ID
            subtask_id: The subtask ID
            user_id: The user ID
        """
        super().__init__(task_id, subtask_id, user_id)
        self._cancelled = False
        self._current_dify_task_id: Optional[str] = None
        self._dify_config: Dict[str, Any] = {}
        self._app_mode: str = "chat"

    async def chat_stream(
        self,
        prompt: str,
        config: Dict[str, Any],
        history: Optional[List[Dict[str, str]]] = None,
    ) -> AsyncIterator[str]:
        """
        Send a chat message to Dify and stream the response.

        Args:
            prompt: The user prompt/message
            config: Configuration dictionary containing:
                - api_key: Dify API key
                - base_url: Dify base URL
                - app_id: Dify app ID (optional)
                - params: Additional parameters for Dify (optional)
            history: Not used for Dify (conversation managed by Dify)

        Yields:
            str: SSE-formatted response chunks
        """
        self._cancelled = False
        self._dify_config = config

        # Get API configuration
        api_key = config.get("api_key", "")
        base_url = config.get("base_url", "https://api.dify.ai")
        params = config.get("params", {})

        if not api_key:
            yield f"data: {json.dumps({'error': 'Dify API key not configured'})}\n\n"
            return

        # Extract params from prompt if present
        prompt, prompt_params = self._extract_params_from_prompt(prompt)
        if prompt_params:
            params.update(prompt_params)

        # Get app mode
        self._app_mode = await self._get_app_mode(api_key, base_url)

        try:
            # Route to appropriate API based on app mode
            if self._app_mode == "workflow":
                async for chunk in self._call_workflow_api(
                    api_key, base_url, prompt, params
                ):
                    if self._cancelled:
                        yield f"data: {json.dumps({'cancelled': True})}\n\n"
                        return
                    yield chunk
            else:
                # chat, chatflow, agent-chat all use chat-messages endpoint
                async for chunk in self._call_chat_api(
                    api_key, base_url, prompt, params
                ):
                    if self._cancelled:
                        yield f"data: {json.dumps({'cancelled': True})}\n\n"
                        return
                    yield chunk

        except Exception as e:
            error_msg = str(e)
            logger.exception(f"Error in Dify stream for task {self.task_id}: {error_msg}")
            yield f"data: {json.dumps({'error': error_msg})}\n\n"

    def _extract_params_from_prompt(self, prompt: str) -> tuple:
        """
        Extract external API parameters from prompt using special markers.

        Format: [EXTERNAL_API_PARAMS]{"param1": "value1"}[/EXTERNAL_API_PARAMS]

        Args:
            prompt: The full prompt text

        Returns:
            Tuple of (cleaned_prompt, params_dict)
        """
        pattern = r'\[EXTERNAL_API_PARAMS\](.*?)\[/EXTERNAL_API_PARAMS\]'
        match = re.search(pattern, prompt, re.DOTALL)

        if not match:
            return prompt, {}

        try:
            params_json = match.group(1).strip()
            params = json.loads(params_json)
            cleaned_prompt = re.sub(pattern, '', prompt, flags=re.DOTALL).strip()
            logger.info(f"Extracted Dify params from prompt: {params}")
            return cleaned_prompt, params
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse Dify params from prompt: {e}")
            return prompt, {}

    async def _get_app_mode(self, api_key: str, base_url: str) -> str:
        """
        Get Dify application mode by calling /v1/info endpoint.

        Args:
            api_key: Dify API key
            base_url: Dify base URL

        Returns:
            Application mode: "chat", "chatflow", "workflow", "agent-chat", "completion"
        """
        try:
            url = f"{base_url}/v1/info"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }

            client = await get_http_client()
            response = await client.get(url, headers=headers, timeout=10.0)
            response.raise_for_status()

            data = response.json()
            app_mode = data.get("mode", "chat")
            logger.info(f"Detected Dify app mode: {app_mode}")
            return app_mode

        except Exception as e:
            logger.warning(f"Failed to get Dify app mode, defaulting to 'chat': {e}")
            return "chat"

    async def _call_chat_api(
        self,
        api_key: str,
        base_url: str,
        query: str,
        params: Dict[str, Any],
    ) -> AsyncIterator[str]:
        """
        Call Dify Chat/Chatflow API with streaming.

        Args:
            api_key: Dify API key
            base_url: Dify base URL
            query: User query
            params: Input parameters for Dify

        Yields:
            str: SSE-formatted response chunks
        """
        url = f"{base_url}/v1/chat-messages"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        # Get conversation ID from session
        conversation_id = await SessionManager.get_dify_conversation_id(self.task_id)

        payload = {
            "inputs": params,
            "query": query,
            "response_mode": "streaming",
            "user": f"task-{self.task_id}",
            "auto_generate_name": True,
        }

        if conversation_id:
            payload["conversation_id"] = conversation_id

        logger.info(f"Calling Dify Chat API ({self._app_mode}): {url}")

        client = await get_http_client()
        full_response = ""

        try:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                if response.status_code != 200:
                    error_text = await response.aread()
                    yield f"data: {json.dumps({'error': f'Dify API error: {response.status_code} - {error_text.decode()}'})}\n\n"
                    return

                async for line in response.aiter_lines():
                    if self._cancelled:
                        # Try to stop the Dify task
                        if self._current_dify_task_id:
                            await self._stop_dify_task(api_key, base_url, self._current_dify_task_id)
                        break

                    if not line or not line.startswith("data: "):
                        continue

                    data_str = line[6:]  # Remove 'data: ' prefix

                    try:
                        data = json.loads(data_str)

                        # Extract task_id for cancellation
                        if "task_id" in data and not self._current_dify_task_id:
                            self._current_dify_task_id = data["task_id"]

                        # Extract conversation_id
                        if "conversation_id" in data:
                            new_conv_id = data["conversation_id"]
                            if new_conv_id != conversation_id:
                                await SessionManager.save_dify_conversation_id(
                                    self.task_id, new_conv_id
                                )

                        event = data.get("event", "")

                        if event == "message" or event == "agent_message":
                            answer = data.get("answer", "")
                            if answer:
                                full_response += answer
                                yield f"data: {json.dumps({'content': answer, 'type': 'content'})}\n\n"

                        elif event == "message_end":
                            yield f"data: {json.dumps({'done': True, 'type': 'done'})}\n\n"

                        elif event == "error":
                            error_msg = data.get("message", "Unknown error")
                            yield f"data: {json.dumps({'error': error_msg})}\n\n"

                    except json.JSONDecodeError:
                        continue

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    async def _call_workflow_api(
        self,
        api_key: str,
        base_url: str,
        query: str,
        params: Dict[str, Any],
    ) -> AsyncIterator[str]:
        """
        Call Dify Workflow API with streaming.

        Args:
            api_key: Dify API key
            base_url: Dify base URL
            query: User query
            params: Input parameters for workflow

        Yields:
            str: SSE-formatted response chunks
        """
        url = f"{base_url}/v1/workflows/run"

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
            "user": f"task-{self.task_id}",
        }

        logger.info(f"Calling Dify Workflow API: {url}")

        client = await get_http_client()
        result_outputs = {}

        try:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                if response.status_code != 200:
                    error_text = await response.aread()
                    yield f"data: {json.dumps({'error': f'Dify Workflow API error: {response.status_code} - {error_text.decode()}'})}\n\n"
                    return

                async for line in response.aiter_lines():
                    if self._cancelled:
                        # Try to stop the Dify workflow task
                        if self._current_dify_task_id:
                            await self._stop_dify_workflow_task(
                                api_key, base_url, self._current_dify_task_id
                            )
                        break

                    if not line or not line.startswith("data: "):
                        continue

                    data_str = line[6:]  # Remove 'data: ' prefix

                    try:
                        data = json.loads(data_str)

                        # Extract task_id for cancellation
                        if "task_id" in data and not self._current_dify_task_id:
                            self._current_dify_task_id = data["task_id"]

                        event = data.get("event", "")

                        if event == "workflow_finished":
                            result_outputs = data.get("data", {}).get("outputs", {})
                            answer_text = json.dumps(result_outputs, ensure_ascii=False, indent=2)
                            yield f"data: {json.dumps({'content': answer_text, 'type': 'content'})}\n\n"
                            yield f"data: {json.dumps({'done': True, 'type': 'done'})}\n\n"

                        elif event == "node_finished":
                            node_title = data.get("data", {}).get("title", "")
                            logger.debug(f"Workflow node finished: {node_title}")

                        elif event == "error":
                            error_msg = data.get("message", "Unknown error")
                            yield f"data: {json.dumps({'error': error_msg})}\n\n"

                    except json.JSONDecodeError:
                        continue

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    async def _stop_dify_task(
        self, api_key: str, base_url: str, dify_task_id: str
    ) -> bool:
        """
        Stop Dify chat/chatflow task using stop API.

        Args:
            api_key: Dify API key
            base_url: Dify base URL
            dify_task_id: Dify task ID to stop

        Returns:
            bool: True if stop was successful
        """
        try:
            url = f"{base_url}/v1/chat-messages/{dify_task_id}/stop"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            payload = {"user": f"task-{self.task_id}"}

            logger.info(f"Stopping Dify task: {dify_task_id}")
            client = await get_http_client()
            response = await client.post(url, headers=headers, json=payload, timeout=10.0)
            response.raise_for_status()

            result = response.json()
            if result.get("result") == "success":
                logger.info(f"Successfully stopped Dify task: {dify_task_id}")
                return True
            return False

        except Exception as e:
            logger.warning(f"Failed to stop Dify task {dify_task_id}: {e}")
            return False

    async def _stop_dify_workflow_task(
        self, api_key: str, base_url: str, dify_task_id: str
    ) -> bool:
        """
        Stop Dify workflow task using stop API.

        Args:
            api_key: Dify API key
            base_url: Dify base URL
            dify_task_id: Dify workflow task ID to stop

        Returns:
            bool: True if stop was successful
        """
        try:
            url = f"{base_url}/v1/workflows/tasks/{dify_task_id}/stop"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            payload = {"user": f"task-{self.task_id}"}

            logger.info(f"Stopping Dify workflow task: {dify_task_id}")
            client = await get_http_client()
            response = await client.post(url, headers=headers, json=payload, timeout=10.0)
            response.raise_for_status()

            result = response.json()
            if result.get("result") == "success":
                logger.info(f"Successfully stopped Dify workflow task: {dify_task_id}")
                return True
            return False

        except Exception as e:
            logger.warning(f"Failed to stop Dify workflow task {dify_task_id}: {e}")
            return False

    async def cancel(self) -> bool:
        """
        Cancel the current Dify chat operation.

        Returns:
            bool: True if cancellation was initiated
        """
        self._cancelled = True
        logger.info(f"Cancellation requested for Dify task {self.task_id}")

        # Try to stop Dify task if we have the ID
        if self._current_dify_task_id and self._dify_config:
            api_key = self._dify_config.get("api_key", "")
            base_url = self._dify_config.get("base_url", "https://api.dify.ai")
            if self._app_mode == "workflow":
                await self._stop_dify_workflow_task(api_key, base_url, self._current_dify_task_id)
            else:
                await self._stop_dify_task(api_key, base_url, self._current_dify_task_id)

        return True
