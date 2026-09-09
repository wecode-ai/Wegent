import io
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.plugin_account_auth import (
    PluginAccountAuthDefinition,
    PluginCredentialWrite,
)
from app.services.plugin_package_parser import PluginPackageParser


def declaration(**changes):
    return {
        "protocolVersion": 1,
        "credentialType": "password",
        "adapter": "scripts/account-auth.py",
        **changes,
    }


def test_parser_preserves_account_auth_alongside_local_auth():
    components = PluginPackageParser()._parse_connectors(
        {
            "connectors": [
                {
                    "slug": "mail",
                    "accountAuth": declaration(),
                    "localAuth": {
                        "kind": "browser_oauth",
                        "health": ["scripts/auth.sh", "health"],
                        "start": ["scripts/auth.sh", "login"],
                    },
                }
            ]
        }
    )
    assert components[0].accountAuth.adapter == "scripts/account-auth.py"
    assert components[0].localAuth.kind == "browser_oauth"
    assert components[0].model_dump()["accountAuth"] == declaration()


def test_local_environment_declares_only_typed_non_secret_settings():
    settings = {
        "DWS_CONFIG_DIR": {"type": "directory"},
        "DWS_DISABLE_KEYCHAIN": {"type": "enum", "values": ["1"]},
    }
    assert (
        PluginAccountAuthDefinition(
            **declaration(localEnvironment=settings)
        ).model_dump()["localEnvironment"]
        == settings
    )


@pytest.mark.parametrize(
    "settings",
    [
        {},
        {"mixedCase": {"type": "directory"}},
        {"MODE": {"type": "string"}},
        {"MODE": {"type": "directory", "values": ["1"]}},
        {"MODE": {"type": "enum", "values": []}},
        {"MODE": {"type": "enum", "values": ["1", "1"]}},
        {"MODE": {"type": "enum", "values": ["value with spaces"]}},
        {"MODE": {"type": "enum", "values": [True]}},
    ],
)
def test_invalid_local_environment_cannot_enter_a_package(settings):
    with pytest.raises(ValidationError):
        PluginAccountAuthDefinition(**declaration(localEnvironment=settings))


@pytest.mark.parametrize(
    "patch",
    [
        {"protocolVersion": 2},
        {"protocolVersion": True},
        {"credentialType": "cookie-directory"},
        {"adapter": "../outside.py"},
        {"adapter": "C:\\outside.py"},
        {"adapter": "/tmp/adapter.py"},
        {"adapter": "~/adapter.py"},
        {"adapter": "scripts/../../adapter.py"},
        {"adapter": "scripts/a.py\n"},
        {"adapter": "scripts/a.py;evil"},
        {"adapter": "scripts"},
        {"password": "must-not-be-in-manifest"},
    ],
)
def test_invalid_auth_declaration_rejects_package_instead_of_downgrading(patch):
    with pytest.raises(HTTPException) as error:
        PluginPackageParser()._parse_connectors(
            {"connectors": [{"slug": "mail", "accountAuth": declaration(**patch)}]}
        )
    assert error.value.status_code == 400
    assert error.value.detail == "Invalid plugin accountAuth declaration"


def test_account_adapter_must_exist_in_package():
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "mail",
                    "connectors": [{"slug": "mail", "accountAuth": declaration()}],
                }
            ),
        )
    with pytest.raises(HTTPException, match="adapter is missing"):
        PluginPackageParser().parse_package(archive.getvalue())


def test_account_adapter_survives_package_normalization():
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "mail",
                    "connectors": [{"slug": "mail", "accountAuth": declaration()}],
                }
            ),
        )
        output.writestr("scripts/account-auth.py", "# Adapter fixture")
    info, _ = PluginPackageParser().normalize_and_parse(archive.getvalue())
    assert info.components.connectors[0].accountAuth == PluginAccountAuthDefinition(
        **declaration()
    )


def test_credential_input_is_redacted_and_size_bounded():
    arguments = dict(
        installed_plugin_id=1,
        connector_slug="mail",
        account_id="account",
        expected_revision=0,
    )
    request = PluginCredentialWrite(**arguments, credential="private-value")
    assert "private-value" not in repr(request)
    assert "private-value" not in request.model_dump_json()
    with pytest.raises(ValidationError) as error:
        PluginCredentialWrite(**arguments, credential="sensitive" * 10000)
    assert "sensitive" not in str(error.value)


@pytest.mark.parametrize("credential_type", ["password", "bearer", "oauth2"])
def test_sdk_scaffold_survives_real_package_normalization(tmp_path, credential_type):
    sdk = Path(__file__).resolve().parents[3] / "sdk" / "plugin-auth"
    subprocess.run(
        [
            sys.executable,
            str(sdk / "tool.py"),
            "scaffold",
            "sample",
            "--parent",
            str(tmp_path),
            "--credential-type",
            credential_type,
        ],
        check=True,
        capture_output=True,
        timeout=10,
    )
    plugin = tmp_path / "sample"
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as output:
        for source in plugin.rglob("*"):
            if source.is_file():
                output.write(source, source.relative_to(plugin))
    info, normalized = PluginPackageParser().normalize_and_parse(archive.getvalue())
    assert info.components.connectors[0].accountAuth.credentialType == credential_type
    with zipfile.ZipFile(io.BytesIO(normalized)) as package:
        for source in (plugin / "scripts/wegent_plugin_auth").iterdir():
            assert package.read(str(source.relative_to(plugin))) == source.read_bytes()
