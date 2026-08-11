# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import zipfile

from app.services.plugin_upstream_adapter import adapt_upstream_package

GITHUB_UPSTREAM_SKILL_PATHS = (
    "skills/gh-address-comments/SKILL.md",
    "skills/gh-fix-ci/SKILL.md",
    "skills/github/SKILL.md",
    "skills/yeet/SKILL.md",
)


def _github_package() -> bytes:
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
                    "interface": {
                        "displayName": "GitHub",
                        "logo": "./assets/logo.png",
                        "composerIcon": "./assets/github-small.svg",
                    },
                }
            ),
        )
        archive.writestr(".app.json", "{}")
        archive.writestr(".mcp.json", "{}")
        archive.writestr("assets/logo.png", b"png")
        archive.writestr("assets/github-small.svg", b"<svg/>")
        for path in GITHUB_UPSTREAM_SKILL_PATHS:
            name = path.split("/")[-2]
            archive.writestr(
                path,
                f"---\nname: {name}\ndescription: English description\n---\n\n# {name}\n",
            )
        archive.writestr("skills/gh-address-comments/LICENSE.txt", "MIT")
        archive.writestr("skills/gh-fix-ci/LICENSE.txt", "MIT")
        archive.writestr("skills/yeet/LICENSE.txt", "MIT")
    return output.getvalue()


def test_upstream_packages_are_passed_through_unchanged():
    package = _github_package()

    adapted = adapt_upstream_package(
        provider="codex",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        package=package,
    )

    assert adapted.package == package
    assert adapted.adapter is None
    assert adapted.adapter_version is None
    assert adapted.upstream_version is None
    with zipfile.ZipFile(io.BytesIO(adapted.package)) as archive:
        manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
        assert manifest["version"] == "0.1.6"
        assert manifest["apps"] == ["app_123"]
        assert manifest["mcpServers"] == {"github": {"command": "legacy"}}
        assert "connectors" not in manifest
        assert ".app.json" in archive.namelist()
        assert ".mcp.json" in archive.namelist()
