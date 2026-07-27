#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""更新 GitHub 插件的图标和中文描述"""

import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text

from app.db.session import SessionLocal
from app.models.plugin_marketplace import Plugin, PluginRelease


def update_github_plugin():
    db = SessionLocal()
    try:
        # 查找 GitHub 插件
        plugin = db.query(Plugin).filter(Plugin.name == "github").first()

        if not plugin:
            print("❌ 未找到 GitHub 插件")
            return

        print(f"✓ 找到插件: {plugin.name} (ID: {plugin.id})")

        # 更新插件的 interface_json，添加图标和中文描述
        interface = plugin.interface_json or {}

        # 添加 GitHub logo URL (使用 GitHub 官方 CDN)
        interface["logo"] = (
            "https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png"
        )
        interface["composerIcon"] = (
            "https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png"
        )

        # 添加中文描述
        interface["displayName"] = "GitHub"
        interface["shortDescription"] = (
            "通过连接器优先的工作流检查仓库、审查拉取请求、处理反馈、调试失败的 Actions 检查，并准备代码更改以供审查，使用有针对性的 CLI 回退。"
        )
        interface["longDescription"] = (
            "使用 GitHub 检查存储库、审查拉取请求、处理反馈、调试失败的 Actions 检查，并通过连接器优先的工作流准备代码更改以供审查，使用有针对性的 CLI 回退。"
        )
        interface["category"] = "Developer Tools"
        interface["developerName"] = "OpenAI"

        # 更新数据库
        plugin.interface_json = interface
        plugin.display_name = "GitHub"
        plugin.summary = "通过连接器优先的工作流检查仓库、审查拉取请求、处理反馈、调试失败的 Actions 检查"
        plugin.description_md = "使用 GitHub 检查存储库、审查拉取请求、处理反馈、调试失败的 Actions 检查，并通过连接器优先的工作流准备代码更改以供审查，使用有针对性的 CLI 回退。"

        # 同时更新 release 的 interface_json
        if plugin.latest_release_id:
            release = (
                db.query(PluginRelease)
                .filter(PluginRelease.id == plugin.latest_release_id)
                .first()
            )

            if release:
                release.interface_json = interface
                print(f"✓ 已更新 Release ID: {release.id}")

        db.commit()
        print("✓ 成功更新 GitHub 插件数据")
        print(f"  - Logo: {interface['logo']}")
        print(f"  - 显示名称: {interface['displayName']}")
        print(f"  - 中文描述: {interface['shortDescription'][:50]}...")

    except Exception as e:
        print(f"❌ 更新失败: {e}")
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    update_github_plugin()
