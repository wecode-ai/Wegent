#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Build ordinary Skill ZIP packages locally for publication through the admin API."""

from __future__ import annotations

import argparse
import io
import re
import sys
import zipfile
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.skill_service import SkillValidator


class CatalogAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")
    source: str
    path: str
    bind_shells: list[Literal["Chat", "ClaudeCode", "Codex", "Agno", "Dify"]] = Field(
        min_length=1
    )


class SkillCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assets: list[CatalogAsset] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_names(self) -> SkillCatalog:
        names = [asset.name for asset in self.assets]
        if len(names) != len(set(names)):
            raise ValueError("Catalog asset names must be unique")
        return self


def _apply_shell_metadata(asset: CatalogAsset, content: bytes) -> bytes:
    text = content.decode()
    frontmatter = re.match(
        r"---[ \t]*\r?\n(.*?)^---[ \t]*(?:\r?\n|\Z)", text, re.MULTILINE | re.DOTALL
    )
    if frontmatter is None:
        raise ValueError(f"Skill source lacks frontmatter: {asset.name}")
    try:
        metadata = yaml.safe_load(frontmatter[1])
    except yaml.YAMLError as error:
        raise ValueError(f"Invalid Skill frontmatter: {asset.name}") from error
    if not isinstance(metadata, dict):
        raise ValueError(f"Invalid Skill frontmatter: {asset.name}")
    if metadata.get("name", asset.name) != asset.name:
        raise ValueError(f"Skill source name mismatch: {asset.name}")
    metadata["bindShells"] = asset.bind_shells
    return (
        f"---\n{yaml.safe_dump(metadata, sort_keys=False)}---\n{text[frontmatter.end():]}"
    ).encode()


def package_asset(asset: CatalogAsset, sources: dict[str, Path]) -> bytes:
    """Keep the full source package, with explicit runtime metadata and stable ZIPs."""
    source = sources.get(asset.source)
    if source is None:
        raise ValueError(f"Missing source {asset.source!r} for Skill: {asset.name}")
    root = source.resolve(strict=True)
    directory = root / asset.path
    if (
        not directory.resolve(strict=True).is_relative_to(root)
        or not directory.is_dir()
    ):
        raise ValueError(f"Skill source escapes its root: {asset.name}")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"Skill source contains a symlink: {asset.name}")
            if path.is_dir():
                continue
            if not path.is_file():
                raise ValueError(
                    f"Skill source contains a nonregular file: {asset.name}"
                )
            relative = path.relative_to(directory)
            if "__pycache__" in relative.parts or path.suffix == ".pyc":
                continue
            content = path.read_bytes()
            if relative.as_posix() == "SKILL.md":
                content = _apply_shell_metadata(asset, content)
            info = zipfile.ZipInfo(f"{asset.name}/{relative.as_posix()}")
            info.create_system = 3
            info.external_attr = (path.stat().st_mode & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
    result = buffer.getvalue()
    SkillValidator.validate_zip(result, f"{asset.name}.zip")
    return result


def write_packages(
    catalog: SkillCatalog, sources: dict[str, Path], output: Path
) -> None:
    """Validate every source before creating a new release output directory."""
    packages = {asset.name: package_asset(asset, sources) for asset in catalog.assets}
    output.mkdir(parents=True, exist_ok=False)
    for name, content in packages.items():
        (output / f"{name}.zip").write_bytes(content)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("--source", action="append", required=True, metavar="KEY=PATH")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    sources: dict[str, Path] = {}
    for source in args.source:
        key, separator, value = source.partition("=")
        if not separator or not key or not value:
            parser.error(f"--source must be KEY=PATH: {source!r}")
        if key in sources:
            parser.error(f"Duplicate source key: {key!r}")
        sources[key] = Path(value)

    catalog = SkillCatalog.model_validate_json(args.catalog.read_text())
    write_packages(catalog, sources, args.output_dir)
    print(f"Wrote {len(catalog.assets)} validated Skill ZIPs to {args.output_dir}")


if __name__ == "__main__":
    main()
