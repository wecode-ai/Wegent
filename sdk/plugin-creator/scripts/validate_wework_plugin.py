#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Compose Codex plugin validation with Wework Connector contract checks."""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any


def packaged_file(root: Path, value: Any) -> bool:
    """Accept regular files inside the distributable, without symlink traversal."""
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_./-]+", value):
        return False
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        return False
    candidate = root
    for part in path.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            return False
    return candidate.is_file()


def validate_environment(value: Any, errors: list[str], label: str) -> None:
    if not isinstance(value, dict) or not 1 <= len(value) <= 16:
        errors.append(f"{label} must contain 1 to 16 non-secret settings")
        return
    for name, setting in value.items():
        valid = isinstance(name, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", name)
        if not isinstance(setting, dict):
            valid = False
        elif setting.get("type") == "directory":
            valid = valid and set(setting) == {"type"}
        elif setting.get("type") == "enum":
            values = setting.get("values")
            valid = (
                valid
                and set(setting) == {"type", "values"}
                and isinstance(values, list)
                and 1 <= len(values) <= 16
                and all(
                    isinstance(item, str)
                    and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", item)
                    for item in values
                )
            )
            if valid:
                valid = len(set(values)) == len(values)
        else:
            valid = False
        if not valid:
            errors.append(f"{label} contains an invalid directory/enum declaration")


def validate_account_auth(
    root: Path, value: Any, errors: list[str], label: str
) -> None:
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return
    required = {"protocolVersion", "credentialType", "adapter"}
    allowed = required | {"oauth2", "exportMode", "localEnvironment"}
    if not required <= set(value) or set(value) - allowed:
        errors.append(f"{label} has missing or unsupported fields")
    if type(value.get("protocolVersion")) is not int or value["protocolVersion"] != 1:
        errors.append(f"{label}.protocolVersion must be integer 1")
    kind = value.get("credentialType")
    if kind not in ("password", "bearer", "oauth2"):
        errors.append(f"{label}.credentialType must be password, bearer, or oauth2")
    adapter = value.get("adapter")
    if (
        not packaged_file(root, adapter)
        or len(adapter) > 256
        or not adapter.endswith((".py", ".mjs", ".sh", ".ps1"))
    ):
        errors.append(f"{label}.adapter must reference a packaged relative script")
    if "oauth2" in value:
        operations = value["oauth2"]
        valid = (
            kind == "oauth2"
            and isinstance(operations, list)
            and bool(operations)
            and all(item in ("authorize", "refresh", "revoke") for item in operations)
        )
        if not valid or len(set(operations)) != len(operations):
            errors.append(
                f"{label}.oauth2 requires distinct supported OAuth operations"
            )
    if "exportMode" in value and (
        value["exportMode"] != "exclusive" or kind != "oauth2"
    ):
        errors.append(f"{label}.exportMode requires exclusive OAuth ownership")
    if "localEnvironment" in value:
        validate_environment(
            value["localEnvironment"], errors, f"{label}.localEnvironment"
        )


def validate_local_auth(root: Path, value: Any, errors: list[str], label: str) -> None:
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return
    kind = value.get("kind", "local_qr")
    if kind not in ("local_qr", "browser_oauth"):
        errors.append(f"{label}.kind must be local_qr or browser_oauth")
    required = {"health", "start"} | ({"poll"} if kind == "local_qr" else set())
    for operation in ("health", "start", "poll", "logout"):
        command = value.get(operation, [])
        if (
            not isinstance(command, list)
            or (operation in required and not command)
            or not all(isinstance(arg, str) and arg.strip() for arg in command)
        ):
            errors.append(f"{label}.{operation} must contain a valid command array")
            continue
        for arg in command:
            if (
                arg.startswith(("/", "~"))
                or ".." in PurePosixPath(arg).parts
                or re.match(r"^[A-Za-z]:[\\/]", arg)
            ):
                errors.append(f"{label}.{operation} must use plugin-relative paths")
            elif arg.startswith(("scripts/", "./scripts/", "bin/", "./bin/")):
                if not packaged_file(root, arg):
                    errors.append(
                        f"{label}.{operation} references a missing packaged file"
                    )


def validate_connectors(root: Path, value: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(value, list):
        return ["connectors must be an array"]
    seen: set[str] = set()
    for index, connector in enumerate(value):
        label = f"connectors[{index}]"
        if not isinstance(connector, dict):
            errors.append(f"{label} must be an object")
            continue
        if set(connector) - {"slug", "authPolicy", "localAuth", "accountAuth"}:
            errors.append(f"{label} contains unsupported fields")
        slug = connector.get("slug")
        if not isinstance(slug, str) or not re.fullmatch(
            r"[a-z0-9][a-z0-9_-]{0,99}", slug
        ):
            errors.append(f"{label}.slug is invalid")
        elif slug in seen:
            errors.append(f"{label}.slug must be unique")
        else:
            seen.add(slug)
        if connector.get("authPolicy", "optional") not in (
            "on_install",
            "on_use",
            "optional",
        ):
            errors.append(f"{label}.authPolicy is invalid")
        if "accountAuth" in connector:
            validate_account_auth(
                root, connector["accountAuth"], errors, f"{label}.accountAuth"
            )
        if "localAuth" in connector:
            validate_local_auth(
                root, connector["localAuth"], errors, f"{label}.localAuth"
            )
    return errors


def load_codex_validator(creator_root: Path) -> Any:
    path = creator_root / "scripts/validate_plugin.py"
    if not path.is_file():
        raise ValueError("Installed Codex plugin-creator validator is missing")
    spec = importlib.util.spec_from_file_location("codex_plugin_validator", path)
    if spec is None or spec.loader is None:
        raise ValueError("Cannot load the installed Codex plugin-creator validator")
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    return validator


def validate_plugin(root: Path, codex_validator: Any) -> list[str]:
    errors: list[str] = []
    manifest = codex_validator.load_json_object(
        root / ".codex-plugin/plugin.json", errors
    )
    if manifest is None:
        return errors
    codex_validator.reject_todo_markers(manifest, "$", errors)
    # Validate standard fields on a projection while retaining the original file
    # and root for asset/skill checks. Never suppress upstream validation errors.
    standard = {key: value for key, value in manifest.items() if key != "connectors"}
    codex_validator.validate_manifest_shape(root, standard, errors)
    if "connectors" in manifest:
        errors.extend(validate_connectors(root, manifest["connectors"]))
    return errors


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plugin_root", type=Path)
    parser.add_argument("--codex-creator-root", type=Path)
    args = parser.parse_args()
    creator_root = args.codex_creator_root
    if creator_root is None:
        home = os.environ.get("WEGENT_CODEX_HOME") or os.environ.get("CODEX_HOME")
        if not home:
            parser.error("Set CODEX_HOME or pass --codex-creator-root")
        creator_root = Path(home) / "skills/.system/plugin-creator"
    try:
        errors = validate_plugin(
            args.plugin_root.resolve(), load_codex_validator(creator_root)
        )
    except (OSError, ValueError, ImportError):
        print(
            "Unable to load plugin or Codex validator; check installation and dependencies."
        )
        raise SystemExit(1) from None
    for error in errors:
        print(error)
    if errors:
        raise SystemExit(1)
    print(
        "Wework plugin structure passed; provider behavior requires separate verification."
    )


if __name__ == "__main__":
    main()
