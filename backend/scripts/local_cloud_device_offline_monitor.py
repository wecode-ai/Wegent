#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Test script for cloud device monitor functionality.

This script runs the cloud device monitoring check every 10 minutes.

Usage:
    cd backend
    uv run python test_monitor.py

Press Ctrl+C to stop gracefully.
"""

import asyncio
import os
import sys
from datetime import datetime
from typing import Optional

# Add current directory to path for imports
sys.path.insert(0, ".")

# Set Nevis configuration before importing nevis_client
os.environ["NEVIS_BASE_URL"] = "http://cloud.nevis.sina.com.cn"
os.environ["NEVIS_MANAGER_ID"] = "abe23321-bad7-4b38-84da-12d5e679edd4"
os.environ["NEVIS_IMAGE_ID"] = "zq8ta5fKzmze1nsp"
os.environ["NEVIS_SIGNATURE"] = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mbyI6eyJ1aWQiOiJhcGktd2VnZW50IiwibmFtZSI6IuiDoeS6kem5jyhhcGktd2VnZW50KSIsImVtYWlsIjoiYXBpLXdlZ2VudCIsImZ1bGxlbWFpbCI6Inl1bnBlbmc3QHN0YWZmLndlaWJvLmNvbSIsIm9yZ2FuaXphdGlvbiI6IuW5s-WPsOaetuaehOeglOWPkSIsIm9yZ2FuaXphdGlvbnQzIjoi5paw5rWq6ZuG5ZuiX-W-ruWNml_lvq7ljZpDT0_nu4Tnu4ciLCJ0ZWxlcGhvbmUiOiJudWxsIn0sImV4cGlyZSI6eyJzZWNvbmRzIjoxODAxNDUxOTQwfX0.7kSDEdEOXHnqTjaqFlAQZghySURAxRnfLEGkFM2v7K4"

import aioping


class PingResult:
    """Represents the result of a ping operation."""

    def __init__(self, status: str, latency_ms: Optional[float] = None):
        self.status = status  # "no_ip", "unreachable", "ok"
        self.latency_ms = latency_ms

    @property
    def is_reachable(self) -> bool:
        return self.status == "ok"


async def ping_device_ip(ip: str, timeout: float = 2.0) -> PingResult:
    """
    Ping a device IP and return latency result.

    Args:
        ip: IP address to ping
        timeout: Timeout in seconds

    Returns:
        PingResult with status ("no_ip", "unreachable", "ok") and latency
    """
    if not ip or ip == "-":
        return PingResult(status="no_ip")
    try:
        delay = await aioping.ping(ip, timeout=timeout)
        return PingResult(status="ok", latency_ms=delay * 1000)
    except Exception:
        return PingResult(status="unreachable")


def format_ping(ping_result: PingResult) -> str:
    """Format ping result for display."""
    if ping_result.status == "no_ip":
        return "no ip ➖"
    elif ping_result.status == "unreachable":
        return "timeout ❌"
    else:
        return f"{ping_result.latency_ms:.0f}ms ✅"


def calculate_latency_stats(ping_results: list) -> dict:
    """Calculate latency statistics from a list of ping results."""
    # Separate results by status
    no_ip_count = sum(1 for r in ping_results if r.status == "no_ip")
    unreachable_count = sum(1 for r in ping_results if r.status == "unreachable")
    valid_latencies = [r.latency_ms for r in ping_results if r.status == "ok"]

    stats = {
        "no_ip": no_ip_count,
        "unreachable": unreachable_count,
        "average": None,
        "min": None,
        "max": None,
    }

    if valid_latencies:
        stats["average"] = sum(valid_latencies) / len(valid_latencies)
        stats["min"] = min(valid_latencies)
        stats["max"] = max(valid_latencies)

    return stats


async def test_monitor():
    """Run monitoring check every 10 minutes."""
    from redis.asyncio import Redis
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.config import settings
    from app.db.session import get_db_session
    from wecode.service.cloud_device_monitor_service import (
        check_cloud_devices_status,
        format_device_table,
        format_device_table_with_ping,
        format_offline_device_table,
        send_monitoring_report,
    )
    from wecode.service.dingtalk_webhook import (
        DINGTALK_WEBHOOK_SECRET,
        DINGTALK_WEBHOOK_URL,
        DingTalkWebhookSender,
    )

    REDIS_URL = "redis://:fpxsHjf3m0Bh4SIA@rm48958.eos.grid.sina.com.cn:48958/0"
    MYSQL_URL = "mysql+pymysql://wegentv2_r:Qap7cUegs9RI1EVC@m7831i.eos.grid.sina.com.cn:7831/task_manager"

    print("=" * 60)
    print("Cloud Device Monitor - Running every 10 minutes")
    print("Press Ctrl+C to stop")
    print("=" * 60)

    redis_client = None
    run_count = 0

    try:
        while True:
            run_count += 1
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            print(f"\n{'=' * 60}")
            print(f"Run #{run_count} - {timestamp}")
            print("=" * 60)

            try:
                # Connect to Redis
                print(f"\n[1/4] Connecting to Redis: {REDIS_URL}")
                redis_client = Redis.from_url(
                    REDIS_URL,
                    encoding="utf-8",
                    decode_responses=True,
                )
                await redis_client.ping()
                print("      ✓ Redis connected")

                # Check device status
                print("\n[2/4] Checking cloud device status...")
                print(f"      Using MySQL: {MYSQL_URL}")

                # Create engine with hardcoded MySQL URL
                engine = create_engine(
                    MYSQL_URL,
                    pool_pre_ping=True,
                    pool_size=10,
                    max_overflow=20,
                    pool_timeout=30,
                    pool_recycle=3600,
                    connect_args={
                        "charset": "utf8mb4",
                        "init_command": "SET time_zone = '+08:00'",
                    },
                )
                SessionLocal = sessionmaker(
                    autocommit=False, autoflush=False, bind=engine
                )

                db = SessionLocal()
                try:
                    result = await check_cloud_devices_status(db, redis_client)
                finally:
                    db.close()

                print(f"      Total devices: {result['total']}")
                print(f"      Online: {result['online_count']} ✅")
                print(f"      Offline: {result['offline_count']} ⚠️")
                print(f"      New offline: {len(result['new_offline'])} 🆕")
                print(f"      Recovered: {len(result['recovered'])} 🔄")

                # Ping all devices (both online and offline) to check network reachability
                print("\n[3/4] Pinging all devices...")
                ping_results = []
                for device_info in result.get("online_devices", []):
                    ping_result = await ping_device_ip(device_info.get("client_ip"))
                    device_info["ping_result"] = ping_result
                    ping_results.append(ping_result)
                for device_info in result.get("offline_devices", []):
                    ping_result = await ping_device_ip(device_info.get("client_ip"))
                    device_info["ping_result"] = ping_result
                    # Only add to ping_results if we have a valid IP to ping
                    if device_info.get("client_ip") and device_info.get("client_ip") != "-":
                        ping_results.append(ping_result)

                # Calculate latency statistics
                stats = calculate_latency_stats(ping_results)

                # Display detailed lists
                print("\n[4/4] Device Details:")

                if result["online_devices"]:
                    print(f"\n      Online Devices ({len(result['online_devices'])}):")
                    print(
                        f"        {'User Name':<12} {'User ID':<10} {'Device ID':<20} {'IP':<16} {'Ping':<12}"
                    )
                    print(f"        {'-'*12} {'-'*10} {'-'*20} {'-'*16} {'-'*12}")
                    for d in result["online_devices"][:5]:  # Show first 5
                        ping_str = format_ping(d.get("ping_result"))
                        ip_str = d.get("client_ip", "-") or "-"
                        print(
                            f"        {d['user_name']:<12} {d['user_id']:<10} {d['device_id']:<20} {ip_str:<16} {ping_str:<12}"
                        )
                    if len(result["online_devices"]) > 5:
                        print(
                            f"        ... and {len(result['online_devices']) - 5} more"
                        )

                # Display latency summary
                print(f"\n      Latency Summary:")
                if stats["average"] is not None:
                    print(f"        Average: {stats['average']:.0f}ms")
                    print(f"        Min: {stats['min']:.0f}ms")
                    print(f"        Max: {stats['max']:.0f}ms")
                if stats["no_ip"] > 0:
                    print(f"        No IP: {stats['no_ip']} ➖")
                if stats["unreachable"] > 0:
                    print(f"        Unreachable: {stats['unreachable']} ❌")

                if result["offline_devices"]:
                    print(
                        f"\n      Offline Devices ({len(result['offline_devices'])}):"
                    )
                    print(
                        f"        {'User Name':<12} {'User ID':<10} {'Device ID':<20} {'Status':<12}"
                    )
                    print(f"        {'-'*12} {'-'*10} {'-'*20} {'-'*12}")
                    for d in result["offline_devices"][:5]:  # Show first 5
                        print(
                            f"        {d['user_name']:<12} {d['user_id']:<10} {d['device_id']:<20} {'offline':<12}"
                        )
                    if len(result["offline_devices"]) > 5:
                        print(
                            f"        ... and {len(result['offline_devices']) - 5} more"
                        )

                if result["new_offline"]:
                    print(f"\n      ⚠️  Newly Offline ({len(result['new_offline'])}):")
                    for device_id in result["new_offline"]:
                        print(f"        - {device_id}")

                if result["recovered"]:
                    print(f"\n      ✅ Recovered Online ({len(result['recovered'])}):")
                    for device_id in result["recovered"]:
                        print(f"        - {device_id}")

                # Generate and display markdown report
                print("\n[5/5] Generated Markdown Report:")
                print("-" * 60)

                report_timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                sections = []
                sections.append(f"### ☁️ 云设备状态监控报告\n")
                sections.append(f"**统计概览**")
                sections.append(f"- 总设备数: {result['total']}")
                sections.append(f"- 在线: {result['online_count']} ✅")
                sections.append(f"- 离线: {result['offline_count']} ⚠️")
                sections.append("")

                # New offline devices
                new_offline_ids = set(result["new_offline"])
                new_offline_devices = [
                    d
                    for d in result["offline_devices"]
                    if d["device_id"] in new_offline_ids
                ]

                if result["new_offline"]:
                    sections.append(
                        f"**新增离线设备 ⚠️ ({len(new_offline_devices)} 个)**"
                    )
                    sections.append("| User Name | User ID | Device ID | IP | Ping |")
                    sections.append("|-----------|---------|-----------|----|------|")
                    sections.append(format_device_table_with_ping(new_offline_devices))
                    sections.append("")

                # Recovered devices
                recovered_ids = set(result["recovered"])
                recovered_devices = [
                    d
                    for d in result["online_devices"]
                    if d["device_id"] in recovered_ids
                ]

                if result["recovered"]:
                    sections.append(
                        f"**恢复在线设备 ✅ ({len(recovered_devices)} 个)**"
                    )
                    sections.append("| User Name | User ID | Device ID | IP | Ping |")
                    sections.append("|-----------|---------|-----------|----|------|")
                    sections.append(format_device_table_with_ping(recovered_devices))
                    sections.append("")

                # Current offline devices list
                if result["offline_count"] > 0:
                    sections.append(
                        f"**当前离线设备列表 ({result['offline_count']} 个)**"
                    )
                    sections.append("| User Name | User ID | Device ID | IP | Ping |")
                    sections.append("|-----------|---------|-----------|----|------|")
                    sections.append(
                        format_device_table_with_ping(result["offline_devices"])
                    )
                    sections.append("")

                # Latency summary section
                if (
                    stats["average"] is not None
                    or stats["no_ip"] > 0
                    or stats["unreachable"] > 0
                ):
                    sections.append("**网络延迟统计**")
                    if stats["average"] is not None:
                        sections.append(f"- 平均延迟: {stats['average']:.0f}ms")
                        sections.append(f"- 最小延迟: {stats['min']:.0f}ms")
                        sections.append(f"- 最大延迟: {stats['max']:.0f}ms")
                    if stats["no_ip"] > 0:
                        sections.append(f"- 无IP设备: {stats['no_ip']} 个")
                    if stats["unreachable"] > 0:
                        sections.append(f"- 不可达设备: {stats['unreachable']} 个")
                    sections.append("")

                sections.append(f"*检查时间: {report_timestamp}*")

                markdown_content = "\n".join(sections)
                print(markdown_content)
                print("-" * 60)

                # Send notification if configured
                should_notify = (
                    result["offline_count"] > 0
                    or result["new_offline"]
                    or result["recovered"]
                )

                if should_notify:
                    if DINGTALK_WEBHOOK_URL.endswith("YOUR_TOKEN"):
                        print("\n⚠️  DingTalk webhook not configured!")
                        print(f"    Current URL: {DINGTALK_WEBHOOK_URL}")
                        print(
                            "    Please update DINGTALK_WEBHOOK_URL and DINGTALK_WEBHOOK_SECRET"
                        )
                        print("    in wecode/service/dingtalk_webhook.py")
                    else:
                        print(f"\n📤 Sending notification to DingTalk...")
                        sender = DingTalkWebhookSender(
                            webhook_url=DINGTALK_WEBHOOK_URL,
                            secret=DINGTALK_WEBHOOK_SECRET,
                        )
                        success = await send_monitoring_report(
                            redis_client, result, sender
                        )
                        if success:
                            print("    ✓ Notification sent successfully!")
                        else:
                            print("    ✗ Failed to send notification")
                else:
                    print("\n✓ No offline devices or changes, skipping notification")

                print("\n" + "=" * 60)
                print("Run completed successfully!")
                print("=" * 60)

            except Exception as e:
                print(f"\n✗ Error during run #{run_count}: {e}")
                import traceback

                traceback.print_exc()
                # Continue to next iteration even if this run failed

            finally:
                # Close Redis connection after each run
                if redis_client:
                    await redis_client.aclose()
                    redis_client = None

            # Wait 10 minutes before next run
            print(f"\n⏳ Waiting 10 minutes before next run...")
            print(f"   (Press Ctrl+C to stop)")
            await asyncio.sleep(600)

    except KeyboardInterrupt:
        print(f"\n\n🛑 Monitoring stopped by user. Total runs: {run_count}")
        return 0

    except Exception as e:
        print(f"\n✗ Fatal error: {e}")
        import traceback

        traceback.print_exc()
        return 1

    finally:
        # Ensure Redis is closed on exit
        if redis_client:
            await redis_client.aclose()

    return 0


if __name__ == "__main__":
    exit_code = asyncio.run(test_monitor())
    sys.exit(exit_code)
