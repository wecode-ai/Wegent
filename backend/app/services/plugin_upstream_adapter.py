# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deterministic adapters for administrator-selected plugin mirrors."""

from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass
from io import BytesIO

import yaml

OPENAI_GITHUB_ADAPTER = "openai-github"
OPENAI_GITHUB_ADAPTER_VERSION = "3"
OPENAI_GITHUB_MARKETPLACE = "openai/plugins"
OPENAI_GITHUB_REMOTE_PLUGIN_ID = "github"
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
SKILL_FRONTMATTER_PATTERN = re.compile(
    r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL
)
OPENAI_GITHUB_SKILL_DESCRIPTIONS = {
    "skills/gh-address-comments/SKILL.md": (
        "处理 GitHub 拉取请求中需要落实的审查反馈。适用于检查未解决的审查线程、"
        "修改请求或行内评论，并实施选定修复；PR 元数据和普通评论使用 GitHub "
        "应用，需要线程状态、解决状态或行内上下文时通过内置 GraphQL 脚本调用 `gh`。"
    ),
    "skills/gh-fix-ci/SKILL.md": (
        "调试或修复 GitHub Actions 中失败的拉取请求检查。通过 GitHub 应用获取 PR "
        "元数据和变更上下文，并使用 `gh` 检查 Actions 状态和日志，在实施修复前先"
        "确认方案。"
    ),
    "skills/github/SKILL.md": (
        "通过已连接的 GitHub 应用梳理仓库、拉取请求和 Issue。适用于一般 GitHub "
        "协助、PR 或 Issue 摘要，以及在选择更具体工作流前了解仓库上下文。"
    ),
    "skills/yeet/SKILL.md": (
        "发布本地代码变更：确认范围、提交代码、推送分支，并通过 GitHub 应用创建"
        "草稿 PR；仅在连接器能力不足时使用 `gh` 作为补充。"
    ),
}


@dataclass(frozen=True)
class AdaptedUpstreamPackage:
    """Package bytes plus provenance added by a selected upstream adapter."""

    package: bytes
    adapter: str | None = None
    adapter_version: str | None = None
    upstream_version: str | None = None


def adapt_upstream_package(
    *,
    provider: str,
    marketplace_name: str,
    remote_plugin_id: str,
    package: bytes,
) -> AdaptedUpstreamPackage:
    """Apply the reviewed adapter registered for one selected upstream."""
    identity = (provider, marketplace_name, remote_plugin_id)
    if identity == (
        "codex",
        OPENAI_GITHUB_MARKETPLACE,
        OPENAI_GITHUB_REMOTE_PLUGIN_ID,
    ):
        return _adapt_openai_github(package)
    return AdaptedUpstreamPackage(package=package)


def _adapt_openai_github(package: bytes) -> AdaptedUpstreamPackage:
    files, modes = _read_plugin_files(package)
    manifest_path = ".codex-plugin/plugin.json"
    required_paths = {
        manifest_path,
        "assets/logo.png",
        "skills/gh-address-comments/LICENSE.txt",
        "skills/gh-fix-ci/LICENSE.txt",
        "skills/yeet/LICENSE.txt",
        *OPENAI_GITHUB_SKILL_DESCRIPTIONS,
    }
    missing = sorted(required_paths.difference(files))
    if missing:
        raise ValueError(
            "OpenAI GitHub upstream is missing required files: " + ", ".join(missing)
        )

    manifest = json.loads(files[manifest_path].decode("utf-8"))
    if manifest.get("name") != OPENAI_GITHUB_REMOTE_PLUGIN_ID:
        raise ValueError("OpenAI GitHub upstream manifest name is invalid")
    upstream_version = str(manifest.get("version") or "").strip()
    if not upstream_version:
        raise ValueError("OpenAI GitHub upstream version is required")
    if "+wegent." in upstream_version:
        raise ValueError("OpenAI GitHub upstream is already adapted")

    manifest["version"] = f"{upstream_version}+wegent.{OPENAI_GITHUB_ADAPTER_VERSION}"
    manifest.pop("apps", None)
    manifest.pop("mcpServers", None)
    manifest["connectors"] = [{"slug": "github", "authPolicy": "on_install"}]
    manifest["description"] = (
        "检查仓库、处理拉取请求和 Issue、调试 CI，并通过 GitHub 连接器与 CLI "
        "工作流发布代码变更。"
    )
    interface = manifest.get("interface")
    if not isinstance(interface, dict):
        interface = {}
        manifest["interface"] = interface
    interface.update(
        {
            "shortDescription": manifest["description"],
            "longDescription": (
                "使用 GitHub 检查仓库、审查拉取请求、处理审查反馈、调试失败的 "
                "Actions 检查，并通过连接器优先的工作流准备待审查的代码变更；"
                "仅在必要时使用 CLI 补充能力。"
            ),
            "category": "开发工具",
            "defaultPrompt": [
                "检查拉取请求、处理 Issue、调试失败的检查，并准备待审查的代码变更"
            ],
            "logo": "./assets/logo.png",
            "composerIcon": "./assets/logo.png",
        }
    )
    files[manifest_path] = (
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    for path, description in OPENAI_GITHUB_SKILL_DESCRIPTIONS.items():
        files[path] = _replace_skill_description(files[path], path, description)
    files.pop(".app.json", None)
    files.pop(".mcp.json", None)

    return AdaptedUpstreamPackage(
        package=_write_plugin_files(files, modes),
        adapter=OPENAI_GITHUB_ADAPTER,
        adapter_version=OPENAI_GITHUB_ADAPTER_VERSION,
        upstream_version=upstream_version,
    )


def _replace_skill_description(content: bytes, path: str, description: str) -> bytes:
    try:
        document = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"OpenAI GitHub skill is not UTF-8: {path}") from exc
    match = SKILL_FRONTMATTER_PATTERN.match(document)
    if not match:
        raise ValueError(f"OpenAI GitHub skill has no YAML frontmatter: {path}")
    try:
        metadata = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise ValueError(f"OpenAI GitHub skill has invalid YAML: {path}") from exc
    if not isinstance(metadata, dict):
        raise ValueError(f"OpenAI GitHub skill frontmatter is invalid: {path}")
    metadata["description"] = description
    frontmatter = yaml.safe_dump(
        metadata,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=4096,
    )
    body = document[match.end() :]
    return f"---\n{frontmatter}---\n{body}".encode("utf-8")


def _read_plugin_files(package: bytes) -> tuple[dict[str, bytes], dict[str, int]]:
    files: dict[str, bytes] = {}
    modes: dict[str, int] = {}
    try:
        with zipfile.ZipFile(BytesIO(package)) as archive:
            for member in archive.infolist():
                if member.is_dir():
                    continue
                files[member.filename] = archive.read(member)
                modes[member.filename] = member.external_attr >> 16
    except zipfile.BadZipFile as exc:
        raise ValueError("Invalid upstream plugin ZIP") from exc
    return files, modes


def _write_plugin_files(files: dict[str, bytes], modes: dict[str, int]) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for path in sorted(files):
            info = zipfile.ZipInfo(path, ZIP_TIMESTAMP)
            info.create_system = 3
            mode = modes.get(path) or 0o100644
            info.external_attr = (mode & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, files[path], compresslevel=9)
    return output.getvalue()
