from pathlib import Path

from app.services.claude_plugin_parser import claude_plugin_parser
from app.services.official_plugin_publisher import OfficialPluginPublisher


def test_curated_github_plugin_uses_wegent_connector_contract() -> None:
    source = (
        Path(__file__).resolve().parents[3] / "curated-plugins" / "openai" / "github"
    )

    built = OfficialPluginPublisher().build_package(source)
    parsed = claude_plugin_parser.parse_package(built.package)

    assert parsed.name == "github"
    assert parsed.version == "0.1.6+wegent.1"
    assert [connector.model_dump() for connector in parsed.components.connectors] == [
        {"slug": "github", "authPolicy": "on_install"}
    ]
    assert parsed.components.mcps == []
    assert parsed.author.startswith("OpenAI")
