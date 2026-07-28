import io
import json
import zipfile
from types import SimpleNamespace

from app.services.claude_plugin_parser import claude_plugin_parser
from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_package_storage import plugin_package_storage
from app.services.plugin_upstream_adapter import adapt_upstream_package


def _adapted_github_package() -> bytes:
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
                    "interface": {"displayName": "GitHub"},
                }
            ),
        )
        archive.writestr(".app.json", "{}")
        archive.writestr(".mcp.json", "{}")
        archive.writestr("assets/logo.png", b"png")
        archive.writestr("skills/github/SKILL.md", "# GitHub")
        archive.writestr("skills/gh-address-comments/LICENSE.txt", "MIT")
        archive.writestr("skills/gh-fix-ci/LICENSE.txt", "MIT")
        archive.writestr("skills/yeet/LICENSE.txt", "MIT")
    return adapt_upstream_package(
        provider="codex",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        package=output.getvalue(),
    ).package


def test_mirrored_github_plugin_uses_wework_connector_contract() -> None:
    parsed = claude_plugin_parser.parse_package(_adapted_github_package())

    assert parsed.name == "github"
    assert parsed.version == "0.1.6+wegent.2"
    assert [connector.model_dump() for connector in parsed.components.connectors] == [
        {"slug": "github", "authPolicy": "on_install"}
    ]
    assert parsed.components.mcps == []
    assert parsed.author.startswith("OpenAI")
    assert parsed.interface is not None
    assert parsed.interface.logo.startswith("data:image/png;base64,")
    assert parsed.interface.composerIcon.startswith("data:image/png;base64,")


def test_marketplace_icon_resolution_preserves_localized_interface(monkeypatch) -> None:
    package = _adapted_github_package()
    monkeypatch.setattr(plugin_package_storage, "get", lambda _key: package)
    release = SimpleNamespace(
        interface_json={
            "displayName": "GitHub",
            "shortDescription": "检查仓库和处理拉取请求",
            "category": "开发工具",
            "logo": "./assets/logo.png",
            "composerIcon": "./assets/logo.png",
        },
        sha256="github-release",
        storage_key="plugins/github.zip",
    )
    plugin = SimpleNamespace(interface_json={})

    resolved = PluginMarketplaceService()._marketplace_interface(release, plugin)

    assert resolved["shortDescription"] == "检查仓库和处理拉取请求"
    assert resolved["category"] == "开发工具"
    assert resolved["logo"].startswith("data:image/png;base64,")
