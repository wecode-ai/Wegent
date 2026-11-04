# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import io
import os
import zipfile
from pathlib import Path

import pytest

from app.services.skill_service import SkillValidator
from scripts.package_skill_catalog import (
    CatalogAsset,
    SkillCatalog,
    package_asset,
    write_packages,
)

pytestmark = pytest.mark.unit
CATALOG = Path(__file__).resolve().parents[2] / "skill_catalogs/document.json"
FORMATS = ["docx", "xlsx", "pptx", "pdf"]


@pytest.fixture
def sources(tmp_path):
    for name in ["document", *FORMATS]:
        directory = tmp_path / name
        (directory / "scripts").mkdir(parents=True)
        metadata = ""
        if name == "document":
            metadata = (
                "provider: {module: provider, class: DocumentToolProvider}\n"
                "tools: [{name: load_document_skill, provider: document}]\n"
                "dependencies: [sandbox]\n"
            )
        (directory / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Test {name}\n{metadata}---\n"
            f"Read scripts/render.py relative to this Skill. {name}\n"
        )
        (directory / "scripts/render.py").write_text("print('v1')\n")
        (directory / "scripts/render.py").chmod(0o755)
        (directory / "provider.py").write_text("# Original Chat provider\n")
    return {"chat": tmp_path, "native": tmp_path}


def catalog():
    return SkillCatalog.model_validate_json(CATALOG.read_text())


def test_packaging_is_complete_deterministic_and_does_not_follow_symlinks(
    sources, tmp_path
):
    asset = catalog().assets[1]
    first = package_asset(asset, sources)
    os.utime(sources["native"] / "docx/SKILL.md", (1, 1))
    assert package_asset(asset, sources) == first
    (sources["native"] / "docx/private").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="symlink"):
        package_asset(asset, sources)
    with pytest.raises(ValueError, match="escapes"):
        package_asset(
            CatalogAsset(
                name="escape", source="native", path="..", bind_shells=["Codex"]
            ),
            sources,
        )


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ("Body\n---\ndescription: not frontmatter\n---\n", "lacks frontmatter"),
        ("---\ndescription: no closing delimiter\n", "lacks frontmatter"),
        ("---\n- invalid metadata\n---\nBody\n", "Invalid Skill frontmatter"),
        ("---\ndescription: [unterminated\n---\nBody\n", "Invalid Skill frontmatter"),
    ],
)
def test_packaging_rejects_invalid_frontmatter(sources, content, message):
    (sources["native"] / "docx" / "SKILL.md").write_text(content)
    asset = next(asset for asset in catalog().assets if asset.name == "docx")
    with pytest.raises(ValueError, match=f"{message}: docx"):
        package_asset(asset, sources)


def test_packaging_preserves_dashes_in_metadata_and_markdown(sources):
    body = "Read the instructions.\n\n---\n\nThen render the file.\n"
    (sources["native"] / "docx" / "SKILL.md").write_text(
        f'---\nname: docx\ndescription: "Create --- documents"\n---\n{body}'
    )
    asset = next(asset for asset in catalog().assets if asset.name == "docx")
    with zipfile.ZipFile(io.BytesIO(package_asset(asset, sources))) as archive:
        skill = archive.read("docx/SKILL.md").decode()
    assert "description: Create --- documents" in skill
    assert skill.endswith(body)


def test_writes_standard_archives_with_shell_metadata(sources, tmp_path):
    output = tmp_path / "release"
    write_packages(catalog(), sources, output)

    assert {path.stem for path in output.glob("*.zip")} == {"document", *FORMATS}
    for name in ["document", *FORMATS]:
        package = output / f"{name}.zip"
        metadata = SkillValidator.validate_zip(package.read_bytes(), package.name)
        with zipfile.ZipFile(package) as archive:
            script_path = f"{name}/scripts/render.py"
            assert archive.read(script_path) == b"print('v1')\n"
            assert archive.getinfo(script_path).external_attr >> 16 & 0o111
            if name == "document":
                assert (
                    archive.read("document/provider.py")
                    == b"# Original Chat provider\n"
                )
                assert metadata["provider"]["class"] == "DocumentToolProvider"
                assert metadata["tools"][0]["name"] == "load_document_skill"
                assert metadata["bindShells"] == ["Chat"]
            else:
                assert metadata["bindShells"] == ["ClaudeCode", "Codex"]

    with pytest.raises(FileExistsError):
        write_packages(catalog(), sources, output)


def test_invalid_source_creates_no_release_directory(sources, tmp_path):
    output = tmp_path / "release"
    (sources["native"] / "pdf" / "SKILL.md").write_text("Invalid Skill")

    with pytest.raises(ValueError, match="frontmatter: pdf"):
        write_packages(catalog(), sources, output)

    assert not output.exists()
