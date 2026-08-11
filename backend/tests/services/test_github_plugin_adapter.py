# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import zipfile
from types import SimpleNamespace

from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_package_parser import plugin_package_parser
from app.services.plugin_package_storage import plugin_package_storage
from app.services.plugin_upstream_adapter import adapt_upstream_package

GITHUB_UPSTREAM_SKILL_PATHS = (
    "skills/gh-address-comments/SKILL.md",
    "skills/gh-fix-ci/SKILL.md",
    "skills/github/SKILL.md",
    "skills/yeet/SKILL.md",
)


def _official_github_package() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "github",
                    "version": "0.1.6",
                    "description": "GitHub workflows",
                    "author": {
                        "name": "OpenAI",
                        "email": "support@openai.com",
                    },
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
    return adapt_upstream_package(
        provider="codex",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        package=output.getvalue(),
    ).package


def test_mirrored_github_plugin_keeps_official_package_contract() -> None:
    parsed = plugin_package_parser.parse_package(_official_github_package())

    assert parsed.name == "github"
    assert parsed.version == "0.1.6"
    assert parsed.components.connectors == []
    assert parsed.author.startswith("OpenAI")
    assert parsed.interface is not None
    assert parsed.interface.logo.startswith("data:image/png;base64,")
    assert parsed.interface.composerIcon.startswith("data:image/svg+xml;base64,")
    assert parsed.interface.logoDark is None
    assert {skill.name for skill in parsed.components.skills} == {
        path.split("/")[-2] for path in GITHUB_UPSTREAM_SKILL_PATHS
    }


def test_marketplace_icon_resolution_preserves_official_interface(monkeypatch) -> None:
    package = _official_github_package()
    monkeypatch.setattr(plugin_package_storage, "get", lambda _key: package)
    release = SimpleNamespace(
        interface_json={
            "displayName": "GitHub",
            "shortDescription": "Triage PRs, issues, CI, and publish flows",
            "category": "Developer Tools",
            "logo": "./assets/logo.png",
            "composerIcon": "./assets/github-small.svg",
        },
        sha256="github-release",
        storage_key="plugins/github.zip",
    )
    plugin = SimpleNamespace(interface_json={})

    resolved = PluginMarketplaceService()._marketplace_interface(release, plugin)

    assert resolved["shortDescription"] == "Triage PRs, issues, CI, and publish flows"
    assert resolved["category"] == "Developer Tools"
    assert resolved["logo"].startswith("data:image/png;base64,")
