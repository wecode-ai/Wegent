# SPDX-License-Identifier: Apache-2.0
"""No provider or keychain access. Exercise public cloud dispatch boundaries."""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wegent_plugin_auth import (
    AuthError,
    delegate_cloud_command,
    run_account_command,
    runtime,
)


class RuntimeTests(unittest.TestCase):
    def test_local_command_does_not_require_a_broker_or_managed_package(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(
                delegate_cloud_command(Path("/missing"), "mail", ["read"])
            )

    def test_cloud_failure_never_downgrades_to_local_auth(self):
        output = io.StringIO()
        with (
            patch.dict(os.environ, {"WEGENT_PLUGIN_AUTH_MODE": "cloud"}, clear=True),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(
                delegate_cloud_command(Path("/missing"), "mail", ["read"]), 1
            )
        self.assertEqual(
            json.loads(output.getvalue()), {"error": "plugin_auth_broker_unavailable"}
        )

    def test_explicit_account_requires_broker_even_in_local_mode(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(
                delegate_cloud_command(
                    Path("/missing"), "mail", ["read"], account_id="alice"
                ),
                1,
            )

    def test_native_execution_context_prevents_recursion_and_is_reset(self):
        with patch.dict(os.environ, {"WEGENT_PLUGIN_AUTH_MODE": "cloud"}, clear=True):
            with runtime.native_execution_scope():
                self.assertIsNone(
                    delegate_cloud_command(
                        Path("/missing"), "mail", ["read"], account_id="alice"
                    )
                )
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(
                    delegate_cloud_command(Path("/missing"), "mail", ["read"]), 1
                )

    def test_only_literal_loopback_broker_addresses_are_allowed(self):
        for url in (
            "https://example.com/v1/run",
            "http://localhost:123/v1/run",
            "http://127.0.0.1:123/v1/run?token=private",
            "http://user@127.0.0.1:123/v1/run",
        ):
            with (
                self.subTest(url=url),
                patch.dict(
                    os.environ,
                    {
                        "WEGENT_PLUGIN_AUTH_BROKER": url,
                        "WEGENT_PLUGIN_AUTH_BROKER_TOKEN": "a" * 64,
                    },
                    clear=True,
                ),
            ):
                with self.assertRaisesRegex(
                    AuthError, "^plugin_auth_broker_unavailable$"
                ):
                    run_account_command(Path("/missing"), "mail", ["read"])

    def test_resolves_only_one_enabled_managed_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            capabilities = home / "capabilities"
            root = capabilities / "store/plugins/mail"
            root.mkdir(parents=True)
            manifest = capabilities / "manifest.json"
            entry = {
                "installed_plugin_id": 42,
                "enabled": True,
                "managed": True,
                "store_path": "store/plugins/mail",
            }
            with patch.dict(os.environ, {"WEGENT_EXECUTOR_HOME": str(home)}):
                manifest.write_text(json.dumps({"plugins": {"mail": entry}}))
                self.assertEqual(runtime._installed_id(root), 42)
                manifest.write_text(
                    json.dumps({"plugins": {"mail": entry, "duplicate": entry}})
                )
                with self.assertRaises(AuthError):
                    runtime._installed_id(root)
                entry["enabled"] = False
                manifest.write_text(json.dumps({"plugins": {"mail": entry}}))
                with self.assertRaises(AuthError):
                    runtime._installed_id(root)
