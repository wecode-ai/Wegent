"""Jupyter WebSocket client for code execution messaging."""

import asyncio
import datetime
import json
import logging
import uuid
from asyncio import Queue
from typing import AsyncGenerator, Dict, Optional, Union

from websockets.client import WebSocketClientProtocol, connect
from websockets.exceptions import ConnectionClosedError, WebSocketException

logger = logging.getLogger(__name__)

MAX_RECONNECT_RETRIES = 3
PING_TIMEOUT = 30


class Execution:
    """Represents an ongoing code execution."""

    def __init__(self, in_background: bool = False):
        self.queue: Queue = Queue()
        self.input_accepted = False
        self.errored = False
        self.in_background = in_background


class ContextWebSocket:
    """WebSocket connection to a Jupyter kernel for code execution."""

    _ws: Optional[WebSocketClientProtocol] = None
    _receive_task: Optional[asyncio.Task] = None

    def __init__(self, context_id: str, session_id: str, language: str, cwd: str):
        self.language = language
        self.cwd = cwd
        self.context_id = context_id
        self.url = f"ws://localhost:8888/api/kernels/{context_id}/channels"
        self.session_id = session_id
        self._executions: Dict[str, Execution] = {}
        self._lock = asyncio.Lock()

    async def reconnect(self):
        """Reconnect to the WebSocket."""
        if self._ws is not None:
            await self._ws.close(reason="Reconnecting")

        if self._receive_task is not None:
            await self._receive_task

        await self.connect()

    async def connect(self):
        """Connect to the Jupyter kernel WebSocket."""
        logger.debug(f"WebSocket connecting to {self.url}")

        ws_logger = logger.getChild("websockets.client")
        ws_logger.setLevel(logging.ERROR)

        self._ws = await connect(
            self.url,
            ping_timeout=PING_TIMEOUT,
            max_size=None,
            max_queue=None,
            logger=ws_logger,
        )

        logger.info(f"WebSocket connected to {self.url}")
        self._receive_task = asyncio.create_task(
            self._receive_message(),
            name="receive_message",
        )

    def _get_execute_request(self, msg_id: str, code: str, background: bool) -> str:
        """Build a Jupyter execute_request message."""
        return json.dumps(
            {
                "header": {
                    "msg_id": msg_id,
                    "username": "wegent",
                    "session": self.session_id,
                    "msg_type": "execute_request",
                    "version": "5.3",
                    "date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                },
                "parent_header": {},
                "metadata": {
                    "trusted": True,
                    "deletedCells": [],
                    "recordTiming": False,
                    "cellId": str(uuid.uuid4()),
                },
                "content": {
                    "code": code,
                    "silent": background,
                    "store_history": True,
                    "user_expressions": {},
                    "stop_on_error": True,
                    "allow_stdin": False,
                },
            }
        )

    async def change_current_directory(self, path: str, language: str):
        """Change the current working directory in the kernel."""
        message_id = str(uuid.uuid4())
        self._executions[message_id] = Execution(in_background=True)

        if language == "python":
            request = self._get_execute_request(message_id, f"%cd {path}", True)
        elif language == "deno":
            request = self._get_execute_request(
                message_id, f"Deno.chdir('{path}')", True
            )
        elif language in ["javascript", "js"]:
            request = self._get_execute_request(
                message_id, f"process.chdir('{path}')", True
            )
        elif language == "r":
            request = self._get_execute_request(message_id, f"setwd('{path}')", True)
        elif language == "java":
            request = self._get_execute_request(
                message_id, f'System.setProperty("user.dir", "{path}");', True
            )
        else:
            del self._executions[message_id]
            return

        await self._ws.send(request)

        async for item in self._wait_for_result(message_id):
            if item.get("type") == "error":
                raise Exception(f"Error during execution: {item}")

        del self._executions[message_id]

    async def _wait_for_result(self, message_id: str) -> AsyncGenerator[dict, None]:
        """Wait for execution results from the queue."""
        queue = self._executions[message_id].queue

        while True:
            output = await queue.get()

            if output.get("type") == "end_of_execution":
                break

            if output.get("type") == "unexpected_end_of_execution":
                logger.error(f"Unexpected end of execution for code ({message_id})")
                yield {
                    "type": "error",
                    "name": "UnexpectedEndOfExecution",
                    "value": "Connection to the execution was closed before the execution was finished",
                    "traceback": "",
                }
                break

            yield output

    async def execute(self, code: str) -> AsyncGenerator[dict, None]:
        """Execute code and stream results.

        Args:
            code: The code to execute

        Yields:
            Dictionary objects with execution results (stdout, stderr, result, error, number_of_executions)
        """
        if self._ws is None:
            raise Exception("WebSocket not connected")

        async with self._lock:
            message_id = str(uuid.uuid4())
            execution = Execution()
            self._executions[message_id] = execution

            # Send the code for execution with retries
            for i in range(1 + MAX_RECONNECT_RETRIES):
                try:
                    logger.info(
                        f"Sending code for execution ({message_id}): {code[:100]}..."
                    )
                    request = self._get_execute_request(message_id, code, False)
                    await self._ws.send(request)
                    break
                except (ConnectionClosedError, WebSocketException) as e:
                    if i < MAX_RECONNECT_RETRIES:
                        logger.warning(
                            f"WebSocket connection lost, {i + 1}. reconnecting...: {str(e)}"
                        )
                        await self.reconnect()
            else:
                # Retry didn't help
                logger.error("Failed to send execution request")
                yield {
                    "type": "error",
                    "name": "WebSocketError",
                    "value": "Failed to send execution request",
                    "traceback": "",
                }
                yield {"type": "unexpected_end_of_execution"}
                del self._executions[message_id]
                return

            # Stream the results
            async for item in self._wait_for_result(message_id):
                yield item

            del self._executions[message_id]

    async def _receive_message(self):
        """Background task to receive messages from WebSocket."""
        if not self._ws:
            logger.error("No WebSocket connection")
            return

        try:
            async for message in self._ws:
                await self._process_message(json.loads(message))
        except Exception as e:
            logger.error(f"WebSocket error while receiving: {str(e)}")
        finally:
            # Notify all ongoing executions about connection loss
            for key, execution in self._executions.items():
                await execution.queue.put(
                    {
                        "type": "error",
                        "name": "WebSocketError",
                        "value": "The connection was lost, rerun the code to get the results",
                        "traceback": "",
                    }
                )
                await execution.queue.put({"type": "unexpected_end_of_execution"})

    async def _process_message(self, data: dict):
        """Process messages from the Jupyter kernel WebSocket.

        Message types documented at:
        https://jupyter-client.readthedocs.io/en/stable/messaging.html
        """
        # Handle kernel restart
        if (
            data.get("msg_type") == "status"
            and data.get("content", {}).get("execution_state") == "restarting"
        ):
            logger.error("Context is restarting")
            for execution in self._executions.values():
                await execution.queue.put(
                    {
                        "type": "error",
                        "name": "ContextRestarting",
                        "value": "Context was restarted",
                        "traceback": "",
                    }
                )
                await execution.queue.put({"type": "end_of_execution"})
            return

        parent_msg_id = data.get("parent_header", {}).get("msg_id")
        if parent_msg_id is None:
            logger.warning("Parent message ID not found: %s", data)
            return

        execution = self._executions.get(parent_msg_id)
        if not execution:
            return

        queue = execution.queue
        msg_type = data.get("msg_type")
        content = data.get("content", {})

        if msg_type == "error":
            logger.debug(f"Execution {parent_msg_id} error: {content.get('ename')}")

            if execution.errored:
                return

            execution.errored = True
            await queue.put(
                {
                    "type": "error",
                    "name": content.get("ename", ""),
                    "value": content.get("evalue", ""),
                    "traceback": "".join(content.get("traceback", [])),
                }
            )

        elif msg_type == "stream":
            stream_name = content.get("name")
            text = content.get("text", "")

            if stream_name == "stdout":
                logger.debug(f"Execution {parent_msg_id} stdout: {text[:50]}...")
                await queue.put({"type": "stdout", "text": text})
            elif stream_name == "stderr":
                logger.debug(f"Execution {parent_msg_id} stderr: {text[:50]}...")
                await queue.put({"type": "stderr", "text": text})

        elif msg_type == "display_data":
            result_data = self._process_result_data(
                content.get("data", {}), is_main_result=False
            )
            logger.debug(f"Execution {parent_msg_id} display data")
            await queue.put(result_data)

        elif msg_type == "execute_result":
            result_data = self._process_result_data(
                content.get("data", {}), is_main_result=True
            )
            logger.debug(f"Execution {parent_msg_id} result")
            await queue.put(result_data)

        elif msg_type == "status":
            state = content.get("execution_state")
            if state == "busy" and execution.in_background:
                logger.debug(f"Execution {parent_msg_id} started")
                execution.input_accepted = True
            elif state == "idle" and execution.input_accepted:
                logger.debug(f"Execution {parent_msg_id} finished")
                await queue.put({"type": "end_of_execution"})
            elif state == "error":
                logger.debug(f"Execution {parent_msg_id} error state")
                await queue.put(
                    {
                        "type": "error",
                        "name": content.get("ename", ""),
                        "value": content.get("evalue", ""),
                        "traceback": "".join(content.get("traceback", [])),
                    }
                )
                await queue.put({"type": "end_of_execution"})

        elif msg_type == "execute_reply":
            status = content.get("status")
            if status == "error":
                logger.debug(f"Execution {parent_msg_id} reply error")
                if execution.errored:
                    return
                execution.errored = True
                await queue.put(
                    {
                        "type": "error",
                        "name": content.get("ename", ""),
                        "value": content.get("evalue", ""),
                        "traceback": "".join(content.get("traceback", [])),
                    }
                )
            elif status == "abort":
                logger.debug(f"Execution {parent_msg_id} aborted")
                await queue.put(
                    {
                        "type": "error",
                        "name": "ExecutionAborted",
                        "value": "Execution was aborted",
                        "traceback": "",
                    }
                )
                await queue.put({"type": "end_of_execution"})

        elif msg_type == "execute_input":
            logger.debug(f"Input accepted for {parent_msg_id}")
            await queue.put(
                {
                    "type": "number_of_executions",
                    "execution_count": content.get("execution_count", 0),
                }
            )
            execution.input_accepted = True

        else:
            logger.warning(f"Unhandled message type: {msg_type}")

    def _process_result_data(self, data: dict, is_main_result: bool) -> dict:
        """Process result data from Jupyter into a standardized format."""
        result = {
            "type": "result",
            "is_main_result": is_main_result,
        }

        # Extract text and strip quotes if present
        text = data.get("text/plain")
        if text:
            if (text.startswith("'") and text.endswith("'")) or (
                text.startswith('"') and text.endswith('"')
            ):
                text = text[1:-1]
            result["text"] = text

        # Extract other formats
        if "text/html" in data:
            result["html"] = data["text/html"]
        if "text/markdown" in data:
            result["markdown"] = data["text/markdown"]
        if "image/svg+xml" in data:
            result["svg"] = data["image/svg+xml"]
        if "image/png" in data:
            result["png"] = data["image/png"]
        if "image/jpeg" in data:
            result["jpeg"] = data["image/jpeg"]
        if "application/pdf" in data:
            result["pdf"] = data["application/pdf"]
        if "text/latex" in data:
            result["latex"] = data["text/latex"]
        if "application/json" in data:
            result["json"] = data["application/json"]
        if "application/javascript" in data:
            result["javascript"] = data["application/javascript"]

        return result

    async def close(self):
        """Close the WebSocket connection."""
        logger.debug(f"Closing WebSocket {self.context_id}")

        if self._ws is not None:
            await self._ws.close()

        if self._receive_task is not None:
            self._receive_task.cancel()

        for execution in self._executions.values():
            execution.queue.put_nowait({"type": "unexpected_end_of_execution"})
