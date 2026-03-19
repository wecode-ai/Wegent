#!/usr/bin/env python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""本地测试 --upgrade 功能的脚本。

无需构建二进制文件，直接在开发环境中测试更新逻辑。
用法: uv run python tests/manual/test_upgrade_local.py [--full]
"""

import argparse
import asyncio
import sys
from pathlib import Path

# 添加项目根目录到路径 (executor 的父目录)
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from executor.services.updater.updater_service import UpdaterService
from executor.services.updater.github_version_checker import GithubVersionChecker
from executor.config.device_config import UpdateConfig


async def test_version_check():
    """测试版本检查功能"""
    print("=" * 60)
    print("测试 1: 版本检查")
    print("=" * 60)

    checker = GithubVersionChecker()

    # 测试平台检测
    binary_name = checker.get_binary_name()
    print(f"\n检测到的平台二进制名称: {binary_name}")

    # 测试版本比较
    test_cases = [
        ("1.0.0", "1.6.6"),
        ("1.6.6", "1.0.0"),
        ("1.0.0", "1.0.0"),
        ("2.0.0", "1.9.9"),
    ]

    print("\n版本比较测试:")
    for current, latest in test_cases:
        result = checker.compare_versions(current, latest)
        status = { -1: "需要更新", 0: "相同版本", 1: "当前更新" }[result]
        print(f"  {current} vs {latest}: {status}")


async def test_update_flow():
    """测试完整更新流程（会真实调用API）"""
    print("\n" + "=" * 60)
    print("测试 2: 完整更新流程")
    print("=" * 60)
    print("\n注意: 这会调用真实的更新API!")
    print("当前只是检查版本，不会真的下载和替换\n")

    # Create update config (empty config defaults to GitHub)
    update_config = UpdateConfig()
    service = UpdaterService(update_config=update_config)

    try:
        result = await service.check_and_update()

        print(f"\n更新结果:")
        print(f"  成功: {result.success}")
        print(f"  已是最新: {result.already_latest}")
        print(f"  旧版本: {result.old_version}")
        print(f"  新版本: {result.new_version}")
        print(f"  错误: {result.error}")
    except Exception as e:
        print(f"测试出错: {e}")
        import traceback
        traceback.print_exc()


def test_binary_path():
    """测试二进制路径检测"""
    print("\n" + "=" * 60)
    print("测试 3: 二进制路径检测")
    print("=" * 60)

    # Create update config (empty config defaults to GitHub)
    update_config = UpdateConfig()
    service = UpdaterService(update_config=update_config)

    # 当前是开发模式，应该返回脚本路径
    path = service._get_current_binary_path()
    print(f"\n检测到的二进制路径: {path}")
    print(f"路径存在: {path.exists()}")


def test_disk_space():
    """测试磁盘空间检查"""
    print("\n" + "=" * 60)
    print("测试 4: 磁盘空间检查")
    print("=" * 60)

    # Create update config (empty config defaults to GitHub)
    update_config = UpdateConfig()
    service = UpdaterService(update_config=update_config)

    result = service._check_disk_space()
    print(f"\n磁盘空间充足: {result}")
    print(f"所需最小空间: {service.MIN_FREE_SPACE / 1024 / 1024:.0f} MB")


def main():
    """主测试函数"""
    parser = argparse.ArgumentParser(description="测试执行器自更新功能")
    parser.add_argument(
        "--full", action="store_true",
        help="运行完整更新流程测试（会调用API）"
    )
    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("执行器自更新功能本地测试")
    print("=" * 60)

    # 测试 1: 版本检查
    asyncio.run(test_version_check())

    # 测试 2: 二进制路径
    test_binary_path()

    # 测试 3: 磁盘空间
    test_disk_space()

    # 测试 4: 完整流程（可选，会调用API）
    if args.full:
        print("\n" + "=" * 60)
        print("运行完整更新流程测试...")
        print("=" * 60)
        asyncio.run(test_update_flow())
    else:
        print("\n" + "=" * 60)
        print("跳过完整流程测试 (使用 --full 参数启用)")
        print("=" * 60)

    print("\n" + "=" * 60)
    print("测试完成!")
    print("=" * 60)


if __name__ == "__main__":
    main()
