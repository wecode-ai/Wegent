import io
import json
import zipfile

import pytest

from app.services.plugin_package_parser import PluginPackageParser


def _plugin_zip(mcp_document: dict[str, object]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "remote-mcp-plugin",
                    "version": "1.0.0",
                    "mcpServers": "./.mcp.json",
                }
            ),
        )
        archive.writestr(".mcp.json", json.dumps(mcp_document))
    return buffer.getvalue()


@pytest.mark.parametrize(
    "mcp_document",
    [
        {
            "remote": {
                "url": "https://mcp.example.com/mcp",
                "http_headers": {"Authorization": "Bearer token"},
            }
        },
        {"mcp_servers": {"remote": {"url": "https://mcp.example.com/mcp"}}},
        {"mcpServers": {"remote": {"url": "https://mcp.example.com/mcp"}}},
    ],
)
def test_parse_package_accepts_standard_and_legacy_mcp_maps(
    mcp_document: dict[str, object],
) -> None:
    package = PluginPackageParser().parse_package(_plugin_zip(mcp_document))

    assert len(package.components.mcps) == 1
    assert package.components.mcps[0].name == "remote"
    assert package.components.mcps[0].server["url"] == "https://mcp.example.com/mcp"
