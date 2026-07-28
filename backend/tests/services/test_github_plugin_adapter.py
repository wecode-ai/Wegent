from pathlib import Path
from types import SimpleNamespace

from app.services.claude_plugin_parser import claude_plugin_parser
from app.services.official_plugin_publisher import OfficialPluginPublisher
from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_package_storage import plugin_package_storage


def test_curated_github_plugin_uses_wegent_connector_contract() -> None:
    source = (
        Path(__file__).resolve().parents[3] / "curated-plugins" / "openai" / "github"
    )

    built = OfficialPluginPublisher().build_package(source)
    parsed = claude_plugin_parser.parse_package(built.package)

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
    source = (
        Path(__file__).resolve().parents[3] / "curated-plugins" / "openai" / "github"
    )
    package = OfficialPluginPublisher().build_package(source).package
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
