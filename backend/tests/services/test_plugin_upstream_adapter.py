# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import zipfile

import pytest

from app.services.plugin_upstream_adapter import (
    OPENAI_GITHUB_ADAPTER,
    adapt_upstream_package,
)


def _github_package(*, include_icon: bool = True) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "github",
                    "version": "0.1.6",
                    "description": "GitHub workflows",
                    "apps": ["app_123"],
                    "mcpServers": {"github": {"command": "legacy"}},
                    "interface": {"displayName": "GitHub"},
                }
            ),
        )
        archive.writestr(".app.json", "{}")
        archive.writestr(".mcp.json", "{}")
        if include_icon:
            archive.writestr("assets/logo.png", b"png")
        archive.writestr("skills/github/SKILL.md", "# GitHub")
        archive.writestr("skills/gh-address-comments/LICENSE.txt", "MIT")
        archive.writestr("skills/gh-fix-ci/LICENSE.txt", "MIT")
        archive.writestr("skills/yeet/LICENSE.txt", "MIT")
    return output.getvalue()


def test_openai_github_adapter_rewrites_runtime_integration_deterministically():
    package = _github_package()

    first = adapt_upstream_package(
        provider="codex",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        package=package,
    )
    second = adapt_upstream_package(
        provider="codex",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        package=package,
    )

    assert first.package == second.package
    assert first.adapter == OPENAI_GITHUB_ADAPTER
    assert first.adapter_version == "2"
    assert first.upstream_version == "0.1.6"
    with zipfile.ZipFile(io.BytesIO(first.package)) as archive:
        manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
        assert manifest["version"] == "0.1.6+wegent.2"
        assert manifest["connectors"] == [
            {"slug": "github", "authPolicy": "on_install"}
        ]
        assert "apps" not in manifest
        assert "mcpServers" not in manifest
        assert manifest["interface"]["logo"] == "./assets/logo.png"
        assert manifest["interface"]["composerIcon"] == "./assets/logo.png"
        assert manifest["interface"]["category"] == "开发工具"
        assert ".app.json" not in archive.namelist()
        assert ".mcp.json" not in archive.namelist()


def test_openai_github_adapter_rejects_an_incomplete_upstream():
    with pytest.raises(ValueError, match="assets/logo.png"):
        adapt_upstream_package(
            provider="codex",
            marketplace_name="openai/plugins",
            remote_plugin_id="github",
            package=_github_package(include_icon=False),
        )


def test_unregistered_upstream_is_not_modified():
    package = _github_package()

    adapted = adapt_upstream_package(
        provider="codex",
        marketplace_name="another-marketplace",
        remote_plugin_id="github",
        package=package,
    )

    assert adapted.package == package
    assert adapted.adapter is None
