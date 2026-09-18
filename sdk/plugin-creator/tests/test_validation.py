"""Structural validation and composition without running provider code."""

from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "wework_validator", ROOT / "scripts/validate_wework_plugin.py"
)
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


class ConnectorValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        (self.root / "scripts/account-auth.py").write_text(
            'raise RuntimeError("Validation must not execute provider code")\n'
        )
        self.connector = {
            "slug": "service",
            "authPolicy": "optional",
            "accountAuth": {
                "protocolVersion": 1,
                "credentialType": "password",
                "adapter": "scripts/account-auth.py",
            },
        }

    def test_password_bearer_and_oauth_declarations(self) -> None:
        for kind in ("password", "bearer", "oauth2"):
            with self.subTest(kind=kind):
                connector = copy.deepcopy(self.connector)
                auth = connector["accountAuth"]
                auth["credentialType"] = kind
                if kind == "oauth2":
                    auth["oauth2"] = ["authorize", "refresh", "revoke"]
                    auth["exportMode"] = "exclusive"
                auth["localEnvironment"] = {
                    "AUTH_DIR": {"type": "directory"},
                    "KEYCHAIN_DISABLED": {"type": "enum", "values": ["1"]},
                }
                self.assertEqual(
                    validator.validate_connectors(self.root, [connector]), []
                )

    def test_rejects_invalid_or_missing_adapter_contracts(self) -> None:
        invalid = (
            {"protocolVersion": True},
            {"protocolVersion": 2},
            {"credentialType": "session"},
            {"adapter": "../scripts/account-auth.py"},
            {"adapter": "/scripts/account-auth.py"},
            {"adapter": "scripts/missing.py"},
            {"adapter": []},
            {"oauth2": ["refresh"]},
            {"oauth2": [["refresh"]]},
            {"exportMode": "exclusive"},
            {"localEnvironment": {"TOKEN": {"type": "secret"}}},
            {
                "localEnvironment": {
                    "AUTH_DIR": {"type": "directory", "value": "/local"}
                }
            },
            {"localEnvironment": {"MODE": {"type": "enum", "values": ["a", "a"]}}},
            {"credential": "must-not-be-in-manifest"},
        )
        for change in invalid:
            with self.subTest(change=change):
                connector = copy.deepcopy(self.connector)
                connector["accountAuth"].update(change)
                self.assertTrue(validator.validate_connectors(self.root, [connector]))

    def test_duplicate_or_malformed_connectors_fail_instead_of_disappearing(
        self,
    ) -> None:
        for connectors in (
            {},
            [None],
            [self.connector, self.connector],
            [{"slug": "UPPER"}],
            [{"slug": "service", "authPolicy": "ON_USE"}],
            [{"slug": "service", "accountAuth": None}],
        ):
            with self.subTest(connectors=connectors):
                self.assertTrue(validator.validate_connectors(self.root, connectors))
        self.assertEqual(validator.validate_connectors(self.root, []), [])
        self.assertEqual(
            validator.validate_connectors(
                self.root, [{"slug": "remote", "authPolicy": "on_use"}]
            ),
            [],
        )

    def test_native_login_requires_real_packaged_commands(self) -> None:
        connector = copy.deepcopy(self.connector)
        connector["localAuth"] = {
            "kind": "local_qr",
            "health": ["python3", "scripts/login.py", "health"],
            "start": ["python3", "scripts/login.py", "start"],
            "poll": ["python3", "scripts/login.py", "poll"],
        }
        self.assertTrue(validator.validate_connectors(self.root, [connector]))
        (self.root / "scripts/login.py").write_text("# Packaged login entry\n")
        self.assertEqual(validator.validate_connectors(self.root, [connector]), [])
        del connector["localAuth"]["poll"]
        self.assertTrue(validator.validate_connectors(self.root, [connector]))
        connector["localAuth"]["kind"] = "browser_oauth"
        self.assertEqual(validator.validate_connectors(self.root, [connector]), [])

    def test_standard_validator_receives_original_root_and_all_standard_fields(
        self,
    ) -> None:
        manifest = {
            "name": "service",
            "connectors": [self.connector],
            "unsupported": True,
        }
        (self.root / ".codex-plugin").mkdir()
        path = self.root / ".codex-plugin/plugin.json"
        content = json.dumps(manifest)
        path.write_text(content)
        received = []

        def validate_standard(root, standard, errors):
            received.append((root, standard))
            errors.append("upstream rejected unsupported")

        upstream = SimpleNamespace(
            load_json_object=lambda path, errors: json.loads(path.read_text()),
            reject_todo_markers=lambda value, path, errors: None,
            validate_manifest_shape=validate_standard,
        )
        self.assertEqual(
            validator.validate_plugin(self.root, upstream),
            ["upstream rejected unsupported"],
        )
        self.assertEqual(
            received, [(self.root, {"name": "service", "unsupported": True})]
        )
        self.assertEqual(path.read_text(), content)


if __name__ == "__main__":
    unittest.main()
