#!/usr/bin/env python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""测试更新 API 连接性"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

import requests
from urllib.parse import urljoin

from executor.services.updater.github_version_checker import GithubVersionChecker


def test_api_connection():
    """测试 API 连接"""
    checker = GithubVersionChecker()
    binary_name = checker.get_binary_name()

    # 构建 API URL (for GitHub API)
    api_url = f"{checker.API_BASE}/repos/{checker._get_github_repo()}/releases/latest"

    print(f"测试 API 连接:")
    print(f"  二进制名称: {binary_name}")
    print(f"  API Base: {checker.API_BASE}")
    print(f"  API URL: {api_url}")
    print(f"  超时设置: {checker.API_TIMEOUT} 秒")
    print()

    # 测试 1: 直接 curl 风格的请求
    print("=" * 60)
    print("测试 1: 使用 requests 直接访问")
    print("=" * 60)

    headers = {"Accept": "application/vnd.github+json"}

    try:
        print(f"正在发送 GET 请求到 {api_url}...")
        response = requests.get(
            api_url,
            headers=headers,
            timeout=checker.API_TIMEOUT,
            verify=True,  # 验证 SSL 证书
        )
        print(f"  状态码: {response.status_code}")
        print(f"  响应头: {dict(response.headers)}")
        print(f"  响应体: {response.text[:500]}")

        if response.status_code == 200:
            data = response.json()
            print(f"\n  ✓ 成功获取更新信息!")
            print(f"  最新版本: {data.get('version')}")
            print(f"  下载地址: {data.get('url', 'N/A')[:80]}...")
        else:
            print(f"\n  ✗ 请求失败: HTTP {response.status_code}")

    except requests.exceptions.SSLError as e:
        print(f"\n  ✗ SSL 错误: {e}")
        print("\n  可能的解决方案:")
        print("  1. 检查系统时间和时区是否正确")
        print("  2. 更新根证书: brew install ca-certificates")
        print("  3. 检查是否需要 VPN 才能访问该域名")
        print("  4. 尝试禁用 SSL 验证（仅用于测试）")

    except requests.exceptions.ConnectionError as e:
        print(f"\n  ✗ 连接错误: {e}")
        print("\n  可能的解决方案:")
        print("  1. 检查网络连接")
        print("  2. 确认域名是否可解析: nslookup ai-state-machine.gemini-emu.com")
        print("  3. 检查防火墙设置")

    except requests.exceptions.Timeout as e:
        print(f"\n  ✗ 连接超时: {e}")

    except Exception as e:
        print(f"\n  ✗ 未知错误: {type(e).__name__}: {e}")

    # 测试 2: 使用浏览器 headers 重试
    print("\n" + "=" * 60)
    print("测试 2: 使用浏览器 User-Agent 重试")
    print("=" * 60)

    browser_headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/vnd.github+json",
    }

    try:
        response = requests.get(
            api_url,
            headers=browser_headers,
            timeout=checker.API_TIMEOUT,
        )
        print(f"  状态码: {response.status_code}")
        if response.status_code == 200:
            print(f"  ✓ 使用浏览器 headers 成功!")

    except Exception as e:
        print(f"  ✗ 仍然失败: {e}")

    # 测试 3: 检查域名解析
    print("\n" + "=" * 60)
    print("测试 3: DNS 解析")
    print("=" * 60)

    import socket
    try:
        hostname = "api.github.com"
        ip = socket.gethostbyname(hostname)
        print(f"  {hostname} -> {ip}")
        print(f"  ✓ DNS 解析成功")
    except socket.gaierror as e:
        print(f"  ✗ DNS 解析失败: {e}")


if __name__ == "__main__":
    test_api_connection()
