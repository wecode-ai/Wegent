import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.services.plugin_package_parser import PluginPackageParser

SKILL_CASES = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "shared/protocol/plugin_skill_discovery_cases.json"
    ).read_text(encoding="utf-8")
)


def _skill_plugin_zip(case: dict, prefix: str = "") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            f"{prefix}.claude-plugin/plugin.json", json.dumps(case["manifest"])
        )
        for path in case.get("directories", []):
            archive.writestr(f"{prefix}{path}", "")
        for path in case.get("files", []):
            archive.writestr(f"{prefix}{path}", "# Skill instructions")
        archive.writestr(
            f"{prefix}.mcp.json",
            json.dumps(
                {
                    "mcpServers": {
                        "remote": {"type": "sse", "url": "https://mcp.example.com/mcp"}
                    }
                }
            ),
        )
    return buffer.getvalue()


@pytest.mark.parametrize("case", SKILL_CASES, ids=lambda case: case["name"])
@pytest.mark.parametrize("prefix", ["", "package/", "package/./"])
def test_plugin_skill_discovery_matches_manifest_and_single_skill_layouts(
    case: dict, prefix: str
) -> None:
    parser = PluginPackageParser()
    package_bytes = _skill_plugin_zip(case, prefix)
    parsed, normalized = parser.normalize_and_parse(package_bytes)

    assert [skill.path for skill in parsed.components.skills] == case["paths"]
    assert len(parsed.components.mcps) == 1
    assert parsed.components.mcps[0].server["type"] == "sse"
    assert parser.parse_package(normalized).components == parsed.components
    root_skills = [skill for skill in parsed.components.skills if skill.path == "."]
    assert all(skill.name == case["manifest"]["name"] for skill in root_skills)


@pytest.mark.parametrize(
    "skills",
    [
        "../outside",
        "/outside",
        "C:/outside",
        "C:outside",
        "./C:/outside",
        "./C:outside",
        "..\\outside",
        "skills/../outside",
        "",
        "SKILL.md",
        "bad\x00path",
        ["skills", "../outside"],
        [4],
        None,
        True,
    ],
)
def test_plugin_skill_directories_reject_invalid_or_escaping_paths(skills) -> None:
    case = {
        "manifest": {"name": "example", "skills": skills},
        "files": ["SKILL.md", "skills/default/SKILL.md"],
    }

    with pytest.raises(HTTPException) as error:
        PluginPackageParser().parse_package(_skill_plugin_zip(case))

    assert error.value.status_code == 400


def test_declared_skill_directory_cannot_traverse_an_existing_file() -> None:
    case = {
        "manifest": {"name": "example", "skills": "readme/child"},
        "files": ["readme", "skills/default/SKILL.md"],
    }

    with pytest.raises(HTTPException) as error:
        PluginPackageParser().parse_package(_skill_plugin_zip(case))

    assert error.value.status_code == 400


def test_codex_manifest_skill_paths_take_precedence_over_claude_manifest() -> None:
    case = {
        "manifest": {"name": "example", "skills": "claude-skills"},
        "files": ["codex-skills/SKILL.md", "claude-skills/SKILL.md"],
    }
    buffer = io.BytesIO(_skill_plugin_zip(case))
    with zipfile.ZipFile(buffer, "a") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps({"name": "example", "skills": "codex-skills"}),
        )

    parsed = PluginPackageParser().parse_package(buffer.getvalue())

    assert [skill.path for skill in parsed.components.skills] == ["codex-skills"]


@pytest.mark.parametrize(
    "style,expected",
    [(">-", "First line second line"), ("|", "First line\nsecond line")],
)
def test_multiline_skill_description_is_preserved_without_body_metadata(
    style, expected
) -> None:
    case = {"manifest": {"name": "example"}}
    buffer = io.BytesIO(_skill_plugin_zip(case))
    with zipfile.ZipFile(buffer, "a") as archive:
        archive.writestr(
            "SKILL.md",
            f"---\nname: actual-name\ndescription: {style}\n  First line\n  second line\n---\nname: body-name\n",
        )

    skill = PluginPackageParser().parse_package(buffer.getvalue()).components.skills[0]

    assert skill.name == "actual-name"
    assert skill.description == expected


def test_quoted_skill_description_decodes_escaped_quotes() -> None:
    buffer = io.BytesIO(_skill_plugin_zip({"manifest": {"name": "example"}}))
    description = 'Use "USB audio host" or don\'t skip the check.'
    with zipfile.ZipFile(buffer, "a") as archive:
        archive.writestr(
            "SKILL.md", f"---\ndescription: {json.dumps(description)}\n---\n"
        )

    skill = PluginPackageParser().parse_package(buffer.getvalue()).components.skills[0]

    assert skill.description == description


def test_normalized_duplicate_skill_paths_are_rejected() -> None:
    case = {
        "manifest": {"name": "example", "skills": "review"},
        "files": ["review/SKILL.md", "review/./SKILL.md"],
    }

    with pytest.raises(HTTPException) as error:
        PluginPackageParser().parse_package(_skill_plugin_zip(case))

    assert error.value.status_code == 400


def test_wrapped_plugin_does_not_collect_skills_from_sibling_directories() -> None:
    case = {"manifest": {"name": "example"}, "files": ["SKILL.md"]}
    buffer = io.BytesIO(_skill_plugin_zip(case, "package/"))
    with zipfile.ZipFile(buffer, "a") as archive:
        archive.writestr("sibling/SKILL.md", "# Unselected")

    skills = PluginPackageParser().parse_package(buffer.getvalue()).components.skills

    assert [(skill.name, skill.path) for skill in skills] == [("example", ".")]


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
            ["git.one.example", "git.two.example", "git.three.example"]
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
