#!/usr/bin/env python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Silent Exit MCP Server.

Provides a silent_exit tool for Agno and Claude Code executors.
When called, this tool signals that the execution should complete silently
without notifying the user (the execution record will be hidden from timeline by default).
"""

import asyncio
import json
import sys

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

# Create MCP server
server = Server("silent-exit-server")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools."""
    return [
        Tool(
            name="silent_exit",
            description=(
                "Call this tool when the execution result does not require user attention. "
                "For example: regular status checks with no anomalies, routine data collection "
                "with expected results, or monitoring tasks where everything is normal. "
                "This will end the execution immediately and hide it from the timeline by default."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Optional reason for silent exit (for logging only, not shown to user)",
                        "default": "",
                    }
                },
                "required": [],
            },
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Handle tool calls."""
    if name == "silent_exit":
        reason = arguments.get("reason", "")
        # Return special marker that executor can detect
        return [
            TextContent(
                type="text",
                text=json.dumps({"__silent_exit__": True, "reason": reason}),
            )
        ]
    raise ValueError(f"Unknown tool: {name}")


async def main():
    """Run the MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, write_stream, server.create_initialization_options()
        )


if __name__ == "__main__":
    asyncio.run(main())
