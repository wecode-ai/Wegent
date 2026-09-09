#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Scaffold plugins and vendor/check the exact dependency-free SDK source."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from wegent_plugin_auth import __version__

ROOT = Path(__file__).resolve().parent
PACKAGE = "wegent_plugin_auth"


def bundle(plugin: Path, *, check: bool = False) -> None:
    source = ROOT / PACKAGE
    files = {p.name: p.read_bytes() for p in source.glob("*.py")}
    files["LICENSE"] = (ROOT / "LICENSE").read_bytes()
    lock = {
        "sdk": "wegent-plugin-auth-python",
        "version": __version__,
        "protocolVersion": 1,
        "files": {
            name: hashlib.sha256(data).hexdigest()
            for name, data in sorted(files.items())
        },
    }
    files["vendor.json"] = (json.dumps(lock, indent=2) + "\n").encode()
    target = plugin / "scripts" / PACKAGE
    if target.is_symlink() or (plugin / "scripts").is_symlink():
        raise ValueError("SDK destination must not use symlinks")
    if check:
        actual = (
            {p.name for p in target.iterdir() if p.name != "__pycache__"}
            if target.is_dir()
            else set()
        )
        if actual != set(files) or any(
            (target / name).is_symlink() or (target / name).read_bytes() != data
            for name, data in files.items()
        ):
            raise ValueError("Bundled SDK differs from canonical source")
    else:
        target.mkdir(parents=True, exist_ok=True)
        unexpected = (
            set(p.name for p in target.iterdir()) - set(files) - {"__pycache__"}
        )
        if unexpected or target.is_symlink():
            raise ValueError("SDK destination contains unexpected files or a symlink")
        for name, data in files.items():
            destination = target / name
            if destination.is_symlink():
                raise ValueError("SDK destination must not contain symlinks")
            destination.write_bytes(data)


def scaffold(parent: Path, name: str, credential_type: str) -> Path:
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
        raise ValueError(
            "Use a lowercase hyphenated plugin name, at most 64 characters"
        )
    fields = {
        "password": "username, password",
        "bearer": "token",
        "oauth2": "access_token, expires_at (Unix seconds), refresh_token for renewable grants",
    }
    required_fields = fields[credential_type]
    plugin = parent / name
    plugin.mkdir(parents=True, exist_ok=False)
    (plugin / ".codex-plugin").mkdir()
    (plugin / "scripts").mkdir()
    manifest = {
        "name": name,
        "version": "0.1.0",
        "description": "Native account authentication adapter development scaffold",
        "license": "Apache-2.0",
        "author": {"name": "Plugin Developer"},
        "interface": {
            "displayName": name,
            "shortDescription": "Account authentication adapter scaffold",
            "longDescription": "Development scaffold; configure the provider before use.",
            "developerName": "Plugin Developer",
            "category": "Development",
            "capabilities": [],
            "defaultPrompt": [],
        },
        "connectors": [
            {
                "slug": name,
                "authPolicy": "optional",
                "accountAuth": {
                    "protocolVersion": 1,
                    "credentialType": credential_type,
                    "adapter": "scripts/account-auth.py",
                },
            }
        ],
    }
    if credential_type == "oauth2":
        manifest["connectors"][0]["accountAuth"]["oauth2"] = [
            "authorize",
            "refresh",
            "revoke",
        ]
    (plugin / ".codex-plugin/plugin.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    for source in (ROOT / "templates").glob("*.tmpl"):
        content = source.read_text(encoding="utf-8")
        for key, value in {
            "__CONNECTOR_SLUG__": name,
            "__CREDENTIAL_TYPE__": credential_type,
            "__REQUIRED_FIELDS__": required_fields,
            "__OAUTH_CALLBACKS__": (
                "    authorize=auth_provider.authorize,\n"
                "    refresh=auth_provider.refresh,\n"
                "    revoke=auth_provider.revoke,\n"
                if credential_type == "oauth2"
                else ""
            ),
            "__OAUTH_PROVIDER__": (
                (ROOT / "templates/oauth-provider.inc").read_text(encoding="utf-8")
                if credential_type == "oauth2"
                else ""
            ),
        }.items():
            content = content.replace(key, value)
        (plugin / "scripts" / source.stem).write_text(content, encoding="utf-8")
    bundle(plugin)
    return plugin


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    vendor = commands.add_parser("vendor")
    vendor.add_argument("plugin", type=Path)
    vendor.add_argument("--check", action="store_true")
    create = commands.add_parser("scaffold")
    create.add_argument("name")
    create.add_argument("--parent", type=Path, required=True)
    create.add_argument(
        "--credential-type", choices=["password", "bearer", "oauth2"], required=True
    )
    args = parser.parse_args()
    if args.command == "vendor":
        if not (args.plugin / ".codex-plugin/plugin.json").is_file():
            parser.error("Destination must be an existing plugin")
        bundle(args.plugin, check=args.check)
    else:
        print(scaffold(args.parent, args.name, args.credential_type))


if __name__ == "__main__":
    main()
