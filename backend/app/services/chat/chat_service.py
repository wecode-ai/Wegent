# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell direct chat service.

Provides streaming chat functionality by directly calling LLM APIs
(OpenAI, Claude) without going through the Docker Executor.
"""

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

import httpx
from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.services.chat.base import ChatServiceBase, get_http_client
from app.services.chat.session_manager import session_manager

logger = logging.getLogger(__name__)

# Thread pool for database operations
_db_executor = ThreadPoolExecutor(max_workers=10)

# Semaphore for concurrent chat limit
_chat_semaphore: Optional[asyncio.Semaphore] = None


def _get_chat_semaphore() -> asyncio.Semaphore:
    """Get or create the chat semaphore for concurrency limiting."""
    global _chat_semaphore
    if _chat_semaphore is None:
        _chat_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CHATS)
    return _chat_semaphore


class ChatService(ChatServiceBase):
    """
    Chat Shell direct chat service.
    
    Handles streaming chat by directly calling LLM APIs.
    """
    
    async def chat_stream(
        self,
        subtask_id: int,
        task_id: int,
        message: Union[str, Dict[str, Any]],
        model_config: Dict[str, Any],
        system_prompt: str = "",
    ) -> StreamingResponse:
        """
        Stream chat response from LLM API.

        Args:
            subtask_id: Subtask ID for status updates
            task_id: Task ID for session history
            message: User message (string or vision dict)
            model_config: Model configuration (api_key, base_url, model_id, model)
            system_prompt: Bot's system prompt

        Returns:
            StreamingResponse with SSE events
        """
        semaphore = _get_chat_semaphore()
        
        async def generate() -> AsyncGenerator[str, None]:
            acquired = False
            # Register this stream for cancellation support (async for Redis)
            cancel_event = await session_manager.register_stream(subtask_id)
            
            try:
                # Try to acquire semaphore with timeout
                try:
                    acquired = await asyncio.wait_for(
                        semaphore.acquire(),
                        timeout=5.0
                    )
                except asyncio.TimeoutError:
                    error_msg = "Too many concurrent chat requests, please try again later"
                    yield f"data: {json.dumps({'error': error_msg})}\n\n"
                    await self._update_subtask_status(subtask_id, "FAILED", error=error_msg)
                    return
                
                # Update status to RUNNING
                await self._update_subtask_status(subtask_id, "RUNNING")
                
                # Get chat history
                history = await session_manager.get_chat_history(task_id)
                
                # Build messages list
                messages = self._build_messages(history, message, system_prompt)
                
                # Call LLM API and stream response with cancellation support
                full_response = ""
                cancelled = False
                
                async for chunk in self._call_llm_streaming_with_cancel(
                    model_config, messages, subtask_id, cancel_event
                ):
                    # Check if cancelled (local event or Redis flag)
                    if cancel_event.is_set() or await session_manager.is_cancelled(subtask_id):
                        cancelled = True
                        break
                    
                    full_response += chunk
                    yield f"data: {json.dumps({'content': chunk, 'done': False})}\n\n"
                
                # Handle cancellation vs normal completion
                if cancelled:
                    # Don't save to chat history - the cancel endpoint will handle saving partial content
                    # Don't update status here - the cancel endpoint already updated it
                    yield f"data: {json.dumps({'content': '', 'done': True, 'cancelled': True})}\n\n"
                else:
                    # Save chat history (only for successful completion)
                    await session_manager.append_user_and_assistant_messages(
                        task_id, message, full_response
                    )
                    
                    # Update status to COMPLETED
                    result = {"value": full_response}
                    await self._update_subtask_status(subtask_id, "COMPLETED", result=result)
                    yield f"data: {json.dumps({'content': '', 'done': True, 'result': result})}\n\n"
                
            except asyncio.CancelledError:
                # Handle asyncio cancellation (e.g., client disconnect)
                logger.info(f"Stream cancelled (asyncio) for subtask {subtask_id}")
                # Don't update status - let the cancel endpoint handle it
                
            except asyncio.TimeoutError:
                error_msg = "API call timeout"
                logger.error(f"Chat stream timeout for subtask {subtask_id}")
                yield f"data: {json.dumps({'error': error_msg})}\n\n"
                await self._update_subtask_status(subtask_id, "FAILED", error=error_msg)
                
            except httpx.RequestError as e:
                error_msg = f"Network error: {str(e)}"
                logger.error(f"Chat stream network error for subtask {subtask_id}: {e}")
                yield f"data: {json.dumps({'error': error_msg})}\n\n"
                await self._update_subtask_status(subtask_id, "FAILED", error=error_msg)
                
            except Exception as e:
                error_msg = str(e)
                logger.error(f"Chat stream error for subtask {subtask_id}: {e}", exc_info=True)
                yield f"data: {json.dumps({'error': error_msg})}\n\n"
                await self._update_subtask_status(subtask_id, "FAILED", error=error_msg)
                
            finally:
                # Cleanup: unregister stream and release semaphore (async for Redis)
                await session_manager.unregister_stream(subtask_id)
                if acquired:
                    semaphore.release()
        
        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",  # Disable nginx buffering
                "Content-Encoding": "none", # Ensure no compression buffering
            }
        )
    
    def _build_messages(
        self,
        history: List[Dict[str, str]],
        current_message: Union[str, Dict[str, Any]],
        system_prompt: str
    ) -> List[Dict[str, Any]]:
        """
        Build message list for LLM API.

        Args:
            history: Previous conversation history
            current_message: Current user message (string or vision dict)
            system_prompt: System prompt

        Returns:
            List of message dictionaries
        """
        messages = []

        # Add system prompt if provided
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        # Add history messages
        messages.extend(history)

        # Add current message
        if isinstance(current_message, dict) and current_message.get("type") == "vision":
            # Build vision message content using standard OpenAI format
            vision_content = [
                {"type": "text", "text": current_message.get("text", "")},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{current_message['mime_type']};base64,{current_message['image_base64']}"
                    }
                }
            ]
            messages.append({"role": "user", "content": vision_content})
        else:
            # Regular text message
            message_text = current_message if isinstance(current_message, str) else current_message.get("text", "")
            messages.append({"role": "user", "content": message_text})

        return messages
    
    async def _call_llm_streaming(
        self,
        model_config: Dict[str, Any],
        messages: List[Dict[str, str]]
    ) -> AsyncGenerator[str, None]:
        """
        Call LLM API with streaming.
        
        Supports OpenAI-compatible APIs and Claude API.
        """
        client = await get_http_client()

        model_type = model_config.get("model", "openai")
        api_key = model_config.get("api_key", "")
        base_url = model_config.get("base_url", "https://api.openai.com/v1")
        model_id = model_config.get("model_id", "gpt-4")
        default_headers = model_config.get("default_headers", {})
        
        # API key is required unless DEFAULT_HEADERS provides authentication
        if not api_key and not default_headers:
            raise ValueError("API key is required (or DEFAULT_HEADERS must be provided)")
        
        # Build request based on model type
        if model_type == "claude":
            async for chunk in self._call_claude_streaming(
                client, api_key, base_url, model_id, messages, default_headers
            ):
                yield chunk
        else:
            async for chunk in self._call_openai_streaming(
                client, api_key, base_url, model_id, messages, default_headers
            ):
                yield chunk
    
    async def _call_llm_streaming_with_cancel(
        self,
        model_config: Dict[str, Any],
        messages: List[Dict[str, str]],
        subtask_id: int,
        cancel_event: asyncio.Event
    ) -> AsyncGenerator[str, None]:
        """
        Call LLM API with streaming and cancellation support.
        """
        client = await get_http_client()

        model_type = model_config.get("model", "openai")
        api_key = model_config.get("api_key", "")
        base_url = model_config.get("base_url", "https://api.openai.com/v1")
        model_id = model_config.get("model_id", "gpt-4")
        default_headers = model_config.get("default_headers", {})
        
        # API key is required unless DEFAULT_HEADERS provides authentication
        if not api_key and not default_headers:
            raise ValueError("API key is required (or DEFAULT_HEADERS must be provided)")
        
        # Build request based on model type with cancellation support
        if model_type == "claude":
            async for chunk in self._call_claude_streaming_with_cancel(
                client, api_key, base_url, model_id, messages, default_headers, subtask_id, cancel_event
            ):
                # Check cancellation before yielding each chunk
                if cancel_event.is_set():
                    return
                yield chunk
        else:
            async for chunk in self._call_openai_streaming_with_cancel(
                client, api_key, base_url, model_id, messages, default_headers, subtask_id, cancel_event
            ):
                # Check cancellation before yielding each chunk
                if cancel_event.is_set():
                    return
                yield chunk
    
    async def _call_openai_streaming(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any] = None
    ) -> AsyncGenerator[str, None]:
        """
        Call OpenAI-compatible API with streaming.
        """
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {
            "Content-Type": "application/json",
        }

        # Only add Authorization header if api_key is provided
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        # Merge default_headers (custom headers take precedence)
        if default_headers:
            headers.update(default_headers)

        # Check if any messages contain vision content (array format)
        processed_messages = []
        has_vision = False

        supports_vision = any(domain in base_url.lower() for domain in [
            "api.openai.com",
            "api.anthropic.com",
            "generativelanguage.googleapis.com",
            "copilot.weibo.com",
        ])

        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, list):
                # This is a multi-part content (vision message)
                has_vision = True

                if supports_vision:
                    # Keep the original vision format
                    processed_messages.append(msg)
                else:
                    # Extract text and note that there's an image
                    text_parts = []
                    image_count = 0
                    for block in content:
                        if block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif block.get("type") == "image_url":
                            image_count += 1
                            text_parts.append(f"[用户上传了图片 {image_count},但当前模型不支持图片识别]")

                    combined_text = "\n".join(text_parts)
                    processed_messages.append({
                        "role": msg["role"],
                        "content": combined_text
                    })
            else:
                processed_messages.append(msg)

        payload = {
            "model": model_id,
            "messages": processed_messages,
            "stream": True,
        }

        async with client.stream("POST", url, json=payload, headers=headers) as response:
            if response.status_code >= 400:
                error_body = await response.aread()
                logger.error(f"OpenAI API error: status={response.status_code}, body={error_body.decode('utf-8', errors='replace')}")
            response.raise_for_status()
            
            async for line in response.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        choices = chunk_data.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                yield content
                    except json.JSONDecodeError:
                        continue
    
    async def _call_claude_streaming(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any] = None
    ) -> AsyncGenerator[str, None]:
        """
        Call Claude API with streaming.
        """
        base_url_stripped = base_url.rstrip('/')
        if base_url_stripped.endswith('/v1'):
            url = f"{base_url_stripped}/messages"
        else:
            url = f"{base_url_stripped}/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        
        # Merge default_headers (custom headers take precedence)
        if default_headers:
            headers.update(default_headers)
        
        # Separate system message from chat messages (Claude API requirement)
        system_content = ""
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_content = msg["content"]
            else:
                content = msg.get("content", "")
                if isinstance(content, str):
                    formatted_content = [{"type": "text", "text": content}]
                elif isinstance(content, list):
                    formatted_content = []
                    for block in content:
                        if block.get("type") == "text":
                            formatted_content.append(block)
                        elif block.get("type") == "image_url":
                            image_url_data = block.get("image_url", {})
                            if isinstance(image_url_data, dict):
                                image_url = image_url_data.get("url", "")
                            else:
                                image_url = image_url_data

                            if image_url.startswith("data:"):
                                parts = image_url.split(",", 1)
                                if len(parts) == 2:
                                    header = parts[0]
                                    base64_data = parts[1]
                                    media_type = header.split(":")[1].split(";")[0]
                                    formatted_content.append({
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": media_type,
                                            "data": base64_data
                                        }
                                    })
                else:
                    formatted_content = [{"type": "text", "text": str(content)}]

                chat_messages.append({
                    "role": msg["role"],
                    "content": formatted_content
                })
        
        payload = {
            "model": model_id,
            "max_tokens": 4096,
            "stream": True,
            "messages": chat_messages,
        }
        if system_content:
            payload["system"] = system_content
        
        async with client.stream("POST", url, json=payload, headers=headers) as response:
            response.raise_for_status()
            
            async for line in response.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        if chunk_data.get("type") == "content_block_delta":
                            delta = chunk_data.get("delta", {})
                            if delta.get("type") == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    yield text
                    except json.JSONDecodeError:
                        continue
    
    async def _call_openai_streaming_with_cancel(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any],
        subtask_id: int,
        cancel_event: asyncio.Event
    ) -> AsyncGenerator[str, None]:
        """
        Call OpenAI-compatible API with streaming and cancellation support.
        """
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {
            "Content-Type": "application/json",
        }

        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        if default_headers:
            headers.update(default_headers)

        processed_messages = []
        has_vision = False

        supports_vision = any(domain in base_url.lower() for domain in [
            "api.openai.com",
            "api.anthropic.com",
            "generativelanguage.googleapis.com",
            "copilot.weibo.com",
        ])

        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, list):
                has_vision = True
                if supports_vision:
                    processed_messages.append(msg)
                else:
                    text_parts = []
                    image_count = 0
                    for block in content:
                        if block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif block.get("type") == "image_url":
                            image_count += 1
                            text_parts.append(f"[用户上传了图片 {image_count},但当前模型不支持图片识别]")
                    combined_text = "\n".join(text_parts)
                    processed_messages.append({
                        "role": msg["role"],
                        "content": combined_text
                    })
            else:
                processed_messages.append(msg)

        payload = {
            "model": model_id,
            "messages": processed_messages,
            "stream": True,
        }

        async with client.stream("POST", url, json=payload, headers=headers) as response:
            if response.status_code >= 400:
                error_body = await response.aread()
                logger.error(f"OpenAI API error: status={response.status_code}, body={error_body.decode('utf-8', errors='replace')}")
            response.raise_for_status()
            
            async for line in response.aiter_lines():
                # Check cancellation at each line
                if cancel_event.is_set():
                    return
                
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        choices = chunk_data.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                yield content
                    except json.JSONDecodeError:
                        continue
    
    async def _call_claude_streaming_with_cancel(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any],
        subtask_id: int,
        cancel_event: asyncio.Event
    ) -> AsyncGenerator[str, None]:
        """
        Call Claude API with streaming and cancellation support.
        """
        base_url_stripped = base_url.rstrip('/')
        if base_url_stripped.endswith('/v1'):
            url = f"{base_url_stripped}/messages"
        else:
            url = f"{base_url_stripped}/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        
        if default_headers:
            headers.update(default_headers)
        
        system_content = ""
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_content = msg["content"]
            else:
                content = msg.get("content", "")
                if isinstance(content, str):
                    formatted_content = [{"type": "text", "text": content}]
                elif isinstance(content, list):
                    formatted_content = []
                    for block in content:
                        if block.get("type") == "text":
                            formatted_content.append(block)
                        elif block.get("type") == "image_url":
                            image_url_data = block.get("image_url", {})
                            if isinstance(image_url_data, dict):
                                image_url = image_url_data.get("url", "")
                            else:
                                image_url = image_url_data

                            if image_url.startswith("data:"):
                                parts = image_url.split(",", 1)
                                if len(parts) == 2:
                                    header = parts[0]
                                    base64_data = parts[1]
                                    media_type = header.split(":")[1].split(";")[0]
                                    formatted_content.append({
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": media_type,
                                            "data": base64_data
                                        }
                                    })
                else:
                    formatted_content = [{"type": "text", "text": str(content)}]

                chat_messages.append({
                    "role": msg["role"],
                    "content": formatted_content
                })
        
        payload = {
            "model": model_id,
            "max_tokens": 4096,
            "stream": True,
            "messages": chat_messages,
        }
        if system_content:
            payload["system"] = system_content
        
        async with client.stream("POST", url, json=payload, headers=headers) as response:
            response.raise_for_status()
            
            async for line in response.aiter_lines():
                # Check cancellation at each line
                if cancel_event.is_set():
                    return
                
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        if chunk_data.get("type") == "content_block_delta":
                            delta = chunk_data.get("delta", {})
                            if delta.get("type") == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    yield text
                    except json.JSONDecodeError:
                        continue
    
    async def _update_subtask_status(
        self,
        subtask_id: int,
        status: str,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None
    ):
        """
        Update subtask status asynchronously.
        """
        loop = asyncio.get_event_loop()
        
        def _update():
            from app.db.session import SessionLocal
            from app.models.subtask import Subtask, SubtaskStatus
            
            db = SessionLocal()
            try:
                subtask = db.query(Subtask).get(subtask_id)
                if subtask:
                    subtask.status = SubtaskStatus(status)
                    subtask.updated_at = datetime.now()
                    
                    if result is not None:
                        subtask.result = result
                    
                    if error is not None:
                        subtask.error_message = error
                    
                    if status in ["COMPLETED", "FAILED", "CANCELLED"]:
                        subtask.completed_at = datetime.now()
                    
                    db.commit()
                    
                    # Also update task status
                    self._update_task_status_sync(db, subtask.task_id)
            except Exception as e:
                logger.error(f"Error updating subtask {subtask_id} status: {e}")
                db.rollback()
            finally:
                db.close()
        
        await loop.run_in_executor(_db_executor, _update)
    
    def _update_task_status_sync(self, db, task_id: int):
        """
        Update task status based on subtask status (synchronous).
        """
        from sqlalchemy.orm.attributes import flag_modified
        
        from app.models.kind import Kind
        from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
        from app.schemas.kind import Task
        
        try:
            task = (
                db.query(Kind)
                .filter(Kind.id == task_id, Kind.kind == "Task", Kind.is_active == True)
                .first()
            )
            if not task:
                return
            
            # Get all assistant subtasks
            subtasks = (
                db.query(Subtask)
                .filter(Subtask.task_id == task_id, Subtask.role == SubtaskRole.ASSISTANT)
                .order_by(Subtask.message_id.asc())
                .all()
            )
            if not subtasks:
                return
            
            task_crd = Task.model_validate(task.json)
            
            # Check last subtask status
            last_subtask = subtasks[-1]
            
            if last_subtask.status == SubtaskStatus.COMPLETED:
                if task_crd.status:
                    task_crd.status.status = "COMPLETED"
                    task_crd.status.progress = 100
                    task_crd.status.result = last_subtask.result
                    task_crd.status.completedAt = datetime.now()
            elif last_subtask.status == SubtaskStatus.FAILED:
                if task_crd.status:
                    task_crd.status.status = "FAILED"
                    task_crd.status.errorMessage = last_subtask.error_message
                    task_crd.status.result = last_subtask.result
            elif last_subtask.status == SubtaskStatus.RUNNING:
                if task_crd.status:
                    task_crd.status.status = "RUNNING"
            
            if task_crd.status:
                task_crd.status.updatedAt = datetime.now()
            
            task.json = task_crd.model_dump(mode="json")
            task.updated_at = datetime.now()
            flag_modified(task, "json")
            
            db.commit()
            
        except Exception as e:
            logger.error(f"Error updating task {task_id} status: {e}")
            db.rollback()


# Global chat service instance
chat_service = ChatService()