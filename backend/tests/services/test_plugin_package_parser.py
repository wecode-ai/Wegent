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


def test_authorization_group_survives_package_parsing_without_merging_accounts() -> (
    None
):
    connectors = [
        {
            "slug": f"tianhe-{index}",
            "displayName": host,
            "description": "Use a read_user PAT from this site.",
            "authorizationGroup": {"id": "tianhe", "displayName": "天河账号"},
            "accountAuth": {
                "protocolVersion": 1,
                "credentialType": "bearer",
                "adapter": f"scripts/auth-{index}.py",
            },
        }
        for index, host in enumerate(
            ["git.intra.weibo.com", "gitlab.weibo.cn", "git.staff.sina.com.cn"]
        )
    ]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {"name": "tianhe", "version": "1.0.0", "connectors": connectors}
            ),
        )
        for connector in connectors:
            archive.writestr(connector["accountAuth"]["adapter"], "# synthetic adapter")
    parsed = (
        PluginPackageParser().parse_package(buffer.getvalue()).components.connectors
    )
    assert len(parsed) == 3
    for expected, actual in zip(connectors, parsed):
        result = actual.model_dump()
        for key, value in expected.items():
            if key != "accountAuth":
                assert result[key] == value
        assert actual.accountAuth.adapter == expected["accountAuth"]["adapter"]
