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

    def test_runtime_copies_use_host_mapping_and_reject_unregistered_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            capabilities = home / "capabilities"
            store = capabilities / "store/plugins/42-mail-1.0"
            codex = home / "codex/plugins/cache/market/mail/1.0"
            claude = home / "claude/plugins/cache/market/mail/1.0"
            old = home / "codex/plugins/cache/market/mail/0.9"
            arbitrary = home / "workspace/mail/1.0"
            for root in (store, codex, claude, old, arbitrary):
                root.mkdir(parents=True)
            entry = {
                "installed_plugin_id": 42,
                "enabled": True,
                "managed": True,
                "store_path": str(store),
                "runtime": {"codex_link": str(codex), "claude_link": str(claude)},
            }
            manifest = capabilities / "manifest.json"
            with patch.dict(os.environ, {"WEGENT_EXECUTOR_HOME": str(home)}):
                manifest.write_text(json.dumps({"plugins": {"mail": entry}}))
                for root in (store, codex, claude):
                    with self.subTest(root=root):
                        self.assertEqual(runtime._installed_id(root), 42)
                for root in (old, arbitrary):
                    with self.subTest(root=root), self.assertRaises(AuthError):
                        runtime._installed_id(root)
                for field in ("enabled", "managed"):
                    changed = {**entry, field: False}
                    manifest.write_text(json.dumps({"plugins": {"mail": changed}}))
                    with self.subTest(field=field), self.assertRaises(AuthError):
                        runtime._installed_id(codex)
                manifest.write_text(
                    json.dumps({"plugins": {"mail": entry, "other": entry}})
                )
                with self.assertRaises(AuthError):
                    runtime._installed_id(codex)

    def test_runtime_copy_dispatches_managed_id_to_broker(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            capabilities = home / "capabilities"
            root = home / "codex/plugins/cache/market/mail/1.0"
            root.mkdir(parents=True)
            capabilities.mkdir()
            (capabilities / "manifest.json").write_text(
                json.dumps(
                    {
                        "plugins": {
                            "mail": {
                                "installed_plugin_id": 42,
                                "managed": True,
                                "enabled": True,
                                "store_path": "store/plugins/mail",
                                "runtime": {"codex_link": str(root)},
                            }
                        }
                    }
                )
            )
            response = io.BytesIO(b'{"stdout":"synthetic mailbox result"}')
            response.status = 200
            with (
                patch.dict(
                    os.environ,
                    {
                        "WEGENT_EXECUTOR_HOME": str(home),
                        "WEGENT_PLUGIN_AUTH_BROKER": "http://127.0.0.1:1234/v1/run",
                        "WEGENT_PLUGIN_AUTH_BROKER_TOKEN": "a" * 64,
                    },
                    clear=True,
                ),
                patch.object(runtime.urllib.request, "build_opener") as build,
            ):
                build.return_value.open.return_value = response
                result = run_account_command(root, "mail", ["list", "--limit", "1"])
            request = build.return_value.open.call_args.args[0]
            payload = json.loads(request.data)
            self.assertEqual(payload["installed_plugin_id"], 42)
            self.assertEqual(payload["args"], ["list", "--limit", "1"])
            self.assertEqual(result, "synthetic mailbox result")
