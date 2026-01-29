"""
Local Device Client - Heartbeat Example
设备侧代码示例 (不在 Wegent 仓库中)
"""

import asyncio
import logging
import platform
import uuid
from datetime import datetime

import socketio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class LocalDeviceClient:
    """Local device client for connecting to Wegent backend"""

    def __init__(self, backend_url: str, user_token: str):
        """
        Initialize device client

        Args:
            backend_url: Wegent backend URL (e.g., "https://api.wegent.ai")
            user_token: User JWT token (obtained from login)
        """
        self.backend_url = backend_url
        self.user_token = self._normalize_token(user_token)
        self.device_id = self._generate_device_id()
        self.device_name = self._get_device_name()

        # Create Socket.IO client
        self.sio = socketio.AsyncClient(
            logger=False,
            engineio_logger=False,
            reconnection=True,
            reconnection_attempts=0,  # Infinite retry
            reconnection_delay=1,
            reconnection_delay_max=5,
        )

        # Register event handlers
        self.sio.on("connect", self.on_connect, namespace="/local-executor")
        self.sio.on("disconnect", self.on_disconnect, namespace="/local-executor")
        self.sio.on("task:execute", self.on_task_execute, namespace="/local-executor")

        self.heartbeat_task = None
        self.is_running = False

    def _normalize_token(self, token: str) -> str:
        """Normalize JWT token by stripping optional Bearer prefix."""
        if not token:
            raise ValueError("JWT token is required")
        token = token.strip()
        if token.lower().startswith("bearer "):
            return token.split(" ", 1)[1]
        return token

    def _generate_device_id(self) -> str:
        """Generate unique device ID based on MAC address"""
        import uuid

        mac = uuid.getnode()
        return f"mac-{mac:012x}"

    def _get_device_name(self) -> str:
        """Get device name from system"""
        return f"{platform.system()} - {platform.node()}"

    async def connect(self):
        """Connect to backend with authentication"""
        try:
            logger.info(f"Connecting to {self.backend_url}/local-executor...")

            await self.sio.connect(
                self.backend_url,
                auth={"token": self.user_token},
                namespaces=["/local-executor"],
                transports=["websocket"],
                socketio_path="/socket.io",
            )

            self.is_running = True
            logger.info("Connected successfully")

        except Exception as e:
            logger.error(f"Connection failed: {e}")
            raise

    async def on_connect(self):
        """Handle connection event"""
        logger.info("[Connected] Registering device...")

        # Set is_running to True here since on_connect is called before connect() returns
        self.is_running = True

        try:
            # Register device
            response = await self.sio.call(
                "device:register",
                {"device_id": self.device_id, "name": self.device_name},
                namespace="/local-executor",
                timeout=10,
            )

            if response.get("success"):
                logger.info(
                    f"[Registered] Device ID: {self.device_id}, Name: {self.device_name}"
                )

                # Start heartbeat
                self.heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            else:
                logger.error(f"[Registration Failed] {response.get('error')}")

        except Exception as e:
            logger.error(f"[Registration Error] {e}")

    async def on_disconnect(self):
        """Handle disconnection event"""
        logger.warning("[Disconnected] Connection lost")
        self.is_running = False

        # Cancel heartbeat task
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
            self.heartbeat_task = None

    async def _heartbeat_loop(self):
        """Send heartbeat every 30 seconds"""
        logger.info("[Heartbeat] Starting heartbeat loop (5s interval)")

        try:
            while self.is_running:
                try:
                    # Send heartbeat immediately (first time) then every 30s
                    logger.info(
                        f"[Heartbeat] Sending heartbeat for device {self.device_id}..."
                    )
                    response = await self.sio.call(
                        "device:heartbeat",
                        {"device_id": self.device_id},
                        namespace="/local-executor",
                        timeout=5,
                    )

                    if response.get("success"):
                        logger.info(f"[Heartbeat] OK - {datetime.now().isoformat()}")
                    else:
                        logger.warning(f"[Heartbeat] Failed: {response.get('error')}")

                except asyncio.TimeoutError:
                    logger.warning("[Heartbeat] Timeout")
                except Exception as e:
                    logger.error(f"[Heartbeat] Error: {e}")

                # Wait 5 seconds before next heartbeat
                await asyncio.sleep(5)

        except asyncio.CancelledError:
            logger.info("[Heartbeat] Stopped")

    async def on_task_execute(self, data: dict):
        """
        Handle task execution request from backend

        Args:
            data: Task data from backend
        """
        import json

        logger.info(f"[Task] Received task: subtask_id={data.get('subtask_id')}")
        logger.info(
            f"[Task] Full task data:\n{json.dumps(data, indent=2, ensure_ascii=False, default=str)}"
        )

        try:
            # Execute task (your implementation here)
            await self._execute_task(data)

        except Exception as e:
            logger.error(f"[Task] Execution failed: {e}")

    async def _execute_task(self, task_data: dict):
        """
        Execute task using Claude Code SDK (simulated streaming response)

        Args:
            task_data: Task data from backend
        """
        subtask_id = task_data["subtask_id"]
        prompt = task_data["prompt"]

        logger.info(f"[Task] Executing subtask {subtask_id}, prompt: {prompt[:50]}...")

        # Simulated streaming response content
        response_chunks = [
            "我收到了你的请求，",
            "让我来分析一下...\n\n",
            "根据你的需求，",
            "我需要执行以下步骤：\n",
            "1. 首先，分析问题\n",
            "2. 然后，制定方案\n",
            "3. 最后，实施解决方案\n\n",
            "正在处理中",
            "...",
            "...",
            "...\n\n",
            "任务已完成！",
            "这是一个模拟的流式响应示例。",
        ]

        accumulated_content = ""

        # Stream chunks with progress updates
        for i, chunk in enumerate(response_chunks):
            accumulated_content += chunk
            progress = int(
                (i + 1) / len(response_chunks) * 90
            )  # Max 90% until complete

            await self.sio.emit(
                "task:progress",
                {
                    "subtask_id": subtask_id,
                    "status": "RUNNING",
                    "progress": progress,
                    "result": {"value": accumulated_content},
                },
                namespace="/local-executor",
            )

            # Simulate typing delay (100-300ms per chunk)
            await asyncio.sleep(0.1 + 0.2 * (len(chunk) / 10))

        # Report completion with final content
        await self.sio.emit(
            "task:complete",
            {
                "subtask_id": subtask_id,
                "status": "COMPLETED",
                "progress": 100,
                "result": {"value": accumulated_content},
            },
            namespace="/local-executor",
        )

        logger.info(f"[Task] Completed subtask {subtask_id}")

    async def disconnect(self):
        """Disconnect from backend"""
        self.is_running = False

        if self.heartbeat_task:
            self.heartbeat_task.cancel()

        await self.sio.disconnect()
        logger.info("Disconnected")

    async def run(self):
        """Run device client (blocks until disconnected)"""
        await self.connect()

        try:
            # Keep running
            while self.is_running:
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            logger.info("Shutting down...")
        finally:
            await self.disconnect()


# ===== Usage Example =====


async def main():
    """Main entry point"""

    # Step 1: Get user token (login first)
    backend_url = "http://localhost:8000"  # Wegent backend URL
    user_token = "Bearer xxxxxxx"  # Replace with actual JWT token

    # Step 2: Create and run device client
    device = LocalDeviceClient(backend_url, user_token)

    try:
        await device.run()
    except Exception as e:
        logger.error(f"Device error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
