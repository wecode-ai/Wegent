# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Meeting resources fetching tool.

This tool fetches available meeting rooms and potential participants
from a remote meeting service API. It returns the resources in a
structured format for the AI to generate a booking form.
"""

import json
import logging
import os
from datetime import datetime
from typing import Any, Optional

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class GetMeetingResourcesInput(BaseModel):
    """Input schema for get_meeting_resources tool."""

    date: str = Field(
        default="",
        description="Query date in ISO format (YYYY-MM-DD). Defaults to today if not provided.",
    )
    start_time: Optional[str] = Field(
        default=None,
        description="Start time in ISO format (HH:MM) to filter available meeting rooms.",
    )
    end_time: Optional[str] = Field(
        default=None,
        description="End time in ISO format (HH:MM) to filter available meeting rooms.",
    )


class GetMeetingResourcesTool(BaseTool):
    """Tool for fetching available meeting resources.

    This tool queries a remote meeting service API to get:
    - Available meeting rooms (with capacity, location, and availability status)
    - Potential participants (with name, department, and email)

    The returned data is used by the AI to generate a meeting booking form
    with intelligent recommendations based on user requirements.
    """

    name: str = "get_meeting_resources"
    display_name: str = "Get Meeting Resources"
    description: str = """Fetch available meeting rooms and potential participants for meeting booking.

Returns:
- rooms: List of meeting rooms with id, name, capacity, location, and availability status
- participants: List of potential participants with id, name, department, and email

Use this tool when helping users schedule or book meetings to get current availability
and participant options.
"""

    args_schema: type[BaseModel] = GetMeetingResourcesInput

    # Injected dependencies - set when creating the tool instance
    task_id: int = 0
    subtask_id: int = 0
    ws_emitter: Any = None

    # Configuration
    api_timeout: int = 30  # seconds

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        date: str = "",
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
    ) -> str:
        """Synchronous execution - handles both sync and async contexts."""
        import asyncio
        import concurrent.futures

        try:
            # Check if we're already in an async context
            asyncio.get_running_loop()
            # Already in async context - run in a thread pool to avoid blocking
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(
                    asyncio.run, self._arun(date, start_time, end_time)
                )
                return future.result()
        except RuntimeError:
            # No running loop - safe to use asyncio.run directly
            return asyncio.run(self._arun(date, start_time, end_time))

    async def _arun(
        self,
        date: str = "",
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
    ) -> str:
        """Async execution to fetch meeting resources from remote API.

        Args:
            date: Query date in YYYY-MM-DD format. Defaults to today.
            start_time: Start time in HH:MM format to filter available rooms.
            end_time: End time in HH:MM format to filter available rooms.

        Returns:
            JSON string with meeting resources (rooms and participants).
        """
        logger.info(
            f"[MeetingBookingTool] Fetching resources: task_id={self.task_id}, "
            f"date={date}, start_time={start_time}, end_time={end_time}"
        )

        # Get API configuration from environment
        api_base_url = os.getenv("MEETING_API_BASE_URL", "")
        api_token = os.getenv("MEETING_API_TOKEN", "")

        if not api_base_url:
            # Return mock data for development/testing
            logger.info(
                "[MeetingBookingTool] No API URL configured, returning mock data"
            )
            return self._get_mock_data(date, start_time, end_time)

        try:
            import httpx

            async with httpx.AsyncClient(timeout=float(self.api_timeout)) as client:
                headers = {"Authorization": f"Bearer {api_token}"} if api_token else {}

                # Use today's date if not provided
                query_date = date or datetime.now().strftime("%Y-%m-%d")

                # Build request params
                params = {"date": query_date}
                if start_time:
                    params["start_time"] = start_time
                if end_time:
                    params["end_time"] = end_time

                # Fetch available rooms
                rooms_response = await client.get(
                    f"{api_base_url}/rooms/available",
                    headers=headers,
                    params=params,
                )
                rooms_data = (
                    rooms_response.json() if rooms_response.status_code == 200 else []
                )

                # Fetch participants list
                participants_response = await client.get(
                    f"{api_base_url}/participants",
                    headers=headers,
                )
                participants_data = (
                    participants_response.json()
                    if participants_response.status_code == 200
                    else []
                )

                logger.info(
                    f"[MeetingBookingTool] Fetched {len(rooms_data)} rooms and "
                    f"{len(participants_data)} participants"
                )

                return json.dumps(
                    {
                        "success": True,
                        "date": query_date,
                        "rooms": rooms_data,
                        "participants": participants_data,
                    },
                    ensure_ascii=False,
                )

        except Exception as e:
            logger.error(f"[MeetingBookingTool] API request failed: {e}", exc_info=True)
            # Fall back to mock data on error
            return self._get_mock_data(date, start_time, end_time)

    def _get_mock_data(
        self,
        date: str,
        start_time: Optional[str],
        end_time: Optional[str],
    ) -> str:
        """Return mock data for development/testing.

        This provides realistic sample data for testing the meeting booking
        flow without requiring an actual meeting service API.

        Args:
            date: Query date
            start_time: Start time filter
            end_time: End time filter

        Returns:
            JSON string with mock meeting resources
        """
        query_date = date or datetime.now().strftime("%Y-%m-%d")

        return json.dumps(
            {
                "success": True,
                "date": query_date,
                "rooms": [
                    {
                        "id": "room_101",
                        "name": "会议室A (101)",
                        "capacity": 10,
                        "location": "1楼东侧",
                        "available": True,
                        "facilities": ["projector", "whiteboard", "video_conf"],
                    },
                    {
                        "id": "room_201",
                        "name": "会议室B (201)",
                        "capacity": 20,
                        "location": "2楼西侧",
                        "available": True,
                        "facilities": ["projector", "whiteboard"],
                    },
                    {
                        "id": "room_301",
                        "name": "大会议室 (301)",
                        "capacity": 50,
                        "location": "3楼中央",
                        "available": False,
                        "facilities": [
                            "projector",
                            "whiteboard",
                            "video_conf",
                            "microphone",
                        ],
                    },
                    {
                        "id": "room_102",
                        "name": "小会议室 (102)",
                        "capacity": 6,
                        "location": "1楼西侧",
                        "available": True,
                        "facilities": ["whiteboard"],
                    },
                    {
                        "id": "room_202",
                        "name": "培训室 (202)",
                        "capacity": 30,
                        "location": "2楼东侧",
                        "available": True,
                        "facilities": [
                            "projector",
                            "whiteboard",
                            "video_conf",
                            "microphone",
                        ],
                    },
                ],
                "participants": [
                    {
                        "id": "user_001",
                        "name": "张三",
                        "department": "技术部",
                        "email": "zhangsan@example.com",
                        "title": "高级工程师",
                    },
                    {
                        "id": "user_002",
                        "name": "李四",
                        "department": "产品部",
                        "email": "lisi@example.com",
                        "title": "产品经理",
                    },
                    {
                        "id": "user_003",
                        "name": "王五",
                        "department": "技术部",
                        "email": "wangwu@example.com",
                        "title": "架构师",
                    },
                    {
                        "id": "user_004",
                        "name": "赵六",
                        "department": "设计部",
                        "email": "zhaoliu@example.com",
                        "title": "UI设计师",
                    },
                    {
                        "id": "user_005",
                        "name": "钱七",
                        "department": "运营部",
                        "email": "qianqi@example.com",
                        "title": "运营总监",
                    },
                    {
                        "id": "user_006",
                        "name": "孙八",
                        "department": "技术部",
                        "email": "sunba@example.com",
                        "title": "测试工程师",
                    },
                    {
                        "id": "user_007",
                        "name": "周九",
                        "department": "市场部",
                        "email": "zhoujiu@example.com",
                        "title": "市场经理",
                    },
                ],
            },
            ensure_ascii=False,
        )
