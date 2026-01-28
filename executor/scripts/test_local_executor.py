#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Test script for local executor mode end-to-end flow.

This script tests the complete flow from dispatching a task to receiving results:
1. Check if backend is running
2. Check if local executor is connected
3. Dispatch a test task
4. Monitor task progress and results

Usage:
    # First, start the backend server
    cd backend && uv run uvicorn app.main:app --port 8000

    # Then, start the local executor in another terminal
    cd executor && EXECUTOR_MODE=local WEGENT_BACKEND_URL=http://localhost:8000 \
        WEGENT_AUTH_TOKEN=test-token uv run python -m executor.main

    # Finally, run this test script
    cd executor && uv run python scripts/test_local_executor.py

    # Or with a custom prompt and API key:
    cd executor && ANTHROPIC_API_KEY=your-key uv run python scripts/test_local_executor.py \
        --prompt "Write a simple hello world function in Python"
"""

import argparse
import asyncio
import json
import os
import sys
import time

import httpx

# Default values
DEFAULT_BACKEND_URL = "http://localhost:8000"
DEFAULT_PROMPT = "Say 'Hello from local executor test!' and nothing else."


def get_backend_url():
    """Get backend URL from environment or default."""
    return os.environ.get("WEGENT_BACKEND_URL", DEFAULT_BACKEND_URL)


async def check_backend_health(backend_url: str) -> bool:
    """Check if backend is running."""
    print(f"\n[1/4] Checking backend health at {backend_url}...")

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(f"{backend_url}/", timeout=5.0)
            if response.status_code == 200:
                data = response.json()
                print(
                    f"  ✓ Backend is running: {data.get('name')} v{data.get('version')}"
                )
                return True
            else:
                print(f"  ✗ Backend returned status {response.status_code}")
                return False
        except httpx.ConnectError:
            print(f"  ✗ Cannot connect to backend at {backend_url}")
            print("    Please start the backend server first:")
            print("    cd backend && uv run uvicorn app.main:app --port 8000")
            return False
        except Exception as e:
            print(f"  ✗ Error checking backend: {e}")
            return False


async def check_executor_status(backend_url: str) -> dict:
    """Check local executor connection status."""
    print("\n[2/4] Checking local executor status...")

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(
                f"{backend_url}/api/internal/local-executor/status", timeout=5.0
            )
            if response.status_code == 200:
                data = response.json()
                if data.get("initialized"):
                    executor_count = data.get("executor_count", 0)
                    if executor_count > 0:
                        print(f"  ✓ {executor_count} executor(s) connected")
                        for executor in data.get("executors", []):
                            print(
                                f"    - {executor.get('hostname')} ({executor.get('executor_type')}) "
                                f"capabilities: {executor.get('capabilities')}"
                            )
                        return {"connected": True, "data": data}
                    else:
                        print("  ✗ No executors connected")
                        print("    Please start a local executor:")
                        print(
                            "    cd executor && EXECUTOR_MODE=local "
                            "WEGENT_BACKEND_URL=http://localhost:8000 "
                            "WEGENT_AUTH_TOKEN=test-token uv run python -m executor.main"
                        )
                        return {"connected": False, "data": data}
                else:
                    print("  ✗ Local executor namespace not initialized")
                    return {"connected": False, "data": data}
            else:
                print(f"  ✗ Status check returned {response.status_code}")
                return {"connected": False, "error": response.text}
        except Exception as e:
            print(f"  ✗ Error checking executor status: {e}")
            return {"connected": False, "error": str(e)}


async def dispatch_test_task(
    backend_url: str, prompt: str, anthropic_api_key: str = None
) -> dict:
    """Dispatch a test task to the local executor."""
    print(f"\n[3/4] Dispatching test task...")
    print(f"  Prompt: {prompt[:50]}..." if len(prompt) > 50 else f"  Prompt: {prompt}")

    payload = {"prompt": prompt}
    if anthropic_api_key:
        payload["anthropic_api_key"] = anthropic_api_key
        print("  Using provided ANTHROPIC_API_KEY")

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                f"{backend_url}/api/internal/local-executor/dispatch-test",
                json=payload,
                timeout=10.0,
            )
            if response.status_code == 200:
                data = response.json()
                if data.get("success"):
                    print(f"  ✓ Task dispatched successfully")
                    print(f"    task_id: {data.get('task_id')}")
                    print(f"    subtask_id: {data.get('subtask_id')}")
                    print(f"    executor_sid: {data.get('executor_sid')}")
                    return {"success": True, "data": data}
                else:
                    print(f"  ✗ Task dispatch failed: {data.get('error')}")
                    return {"success": False, "data": data}
            else:
                print(f"  ✗ Dispatch returned status {response.status_code}")
                print(f"    Response: {response.text}")
                return {"success": False, "error": response.text}
        except Exception as e:
            print(f"  ✗ Error dispatching task: {e}")
            return {"success": False, "error": str(e)}


async def monitor_task(backend_url: str, task_id: int, timeout: int = 120) -> bool:
    """Monitor task progress (basic monitoring via status endpoint)."""
    print(f"\n[4/4] Monitoring task {task_id}...")
    print(f"  (Timeout: {timeout}s)")
    print("  Note: Watch the executor terminal for detailed progress")

    start_time = time.time()

    # Simple polling of status endpoint
    # In a real scenario, you would connect via WebSocket to receive real-time updates
    async with httpx.AsyncClient() as client:
        while time.time() - start_time < timeout:
            try:
                response = await client.get(
                    f"{backend_url}/api/internal/local-executor/status", timeout=5.0
                )
                if response.status_code == 200:
                    data = response.json()
                    pending_count = data.get("pending_task_count", 0)
                    elapsed = int(time.time() - start_time)
                    print(f"  [{elapsed}s] Pending tasks: {pending_count}", end="\r")
            except Exception:
                pass

            await asyncio.sleep(2)

    print(f"\n  Task monitoring completed (timeout reached)")
    print("  Check executor terminal for task results")
    return True


async def main():
    """Main test function."""
    parser = argparse.ArgumentParser(description="Test local executor end-to-end flow")
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help="Task prompt to send to executor",
    )
    parser.add_argument(
        "--backend-url",
        default=None,
        help="Backend URL (default: from WEGENT_BACKEND_URL or http://localhost:8000)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=60,
        help="Task monitoring timeout in seconds (default: 60)",
    )
    parser.add_argument(
        "--skip-dispatch",
        action="store_true",
        help="Skip task dispatch, only check status",
    )
    args = parser.parse_args()

    backend_url = args.backend_url or get_backend_url()
    anthropic_api_key = os.environ.get("ANTHROPIC_API_KEY")

    print("=" * 60)
    print("Local Executor End-to-End Test")
    print("=" * 60)

    # Step 1: Check backend health
    if not await check_backend_health(backend_url):
        print("\n❌ Test failed: Backend is not available")
        return 1

    # Step 2: Check executor status
    status_result = await check_executor_status(backend_url)
    if not status_result.get("connected"):
        print("\n❌ Test failed: No local executor connected")
        return 1

    if args.skip_dispatch:
        print("\n✅ Status check completed (dispatch skipped)")
        return 0

    # Step 3: Dispatch test task
    dispatch_result = await dispatch_test_task(
        backend_url, args.prompt, anthropic_api_key
    )
    if not dispatch_result.get("success"):
        print("\n❌ Test failed: Could not dispatch task")
        return 1

    # Step 4: Monitor task (basic)
    task_id = dispatch_result["data"].get("task_id")
    await monitor_task(backend_url, task_id, args.timeout)

    print("\n" + "=" * 60)
    print("✅ Test completed!")
    print("Check executor terminal for detailed task execution results.")
    print("=" * 60)

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
