# SPDX-License-Identifier: Apache-2.0
"""Synthetic credentials only. No provider access or local keychain operations."""

from __future__ import annotations

import contextlib
import io
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import tool  # noqa: E402 - load canonical source without installing the package
from wegent_plugin_auth import (  # noqa: E402
    AccountAuthAdapter,
    AuthError,
)
from wegent_plugin_auth import adapter as adapter_module  # noqa: E402
from wegent_plugin_auth import (  # noqa: E402
    local_configuration,
)
from wegent_plugin_auth.transport import (  # noqa: E402
    MAX_FRAME_BYTES,
    open_pipe,
    read_frame,
    write_frame,
)

SECRET = "synthetic-private-secret"


def make_adapter(credential_type="password", **overrides):
    values = dict(
        connector_slug="sample",
        credential_type=credential_type,
        export=lambda: {"username": "alice", "password": SECRET},
        account_id=lambda value: "alice",
        execute=lambda value, args: 0,
        allowed_commands=("read",),
    )
    values.update(overrides)
    return AccountAuthAdapter(**values)


def envelope(credential=None, **changes):
    result = dict(
        protocolVersion=1,
        connectorSlug="sample",
        credentialType="password",
        credential=(
            {"username": "alice", "password": SECRET}
            if credential is None
            else credential
        ),
    )
    result.update(changes)
    return result


def frame(payload):
    result = io.BytesIO()
    write_frame(result, payload)
    result.seek(0)
    return result


class SDKTests(unittest.TestCase):
    def test_local_configuration_is_explicit_bounded_and_does_not_override_environment(
        self,
    ):
        key = "WEGENT_PLUGIN_AUTH_LOCAL_CONFIGURATION"
        with patch.dict(
            os.environ, {key: '{"PATH":"/synthetic/provider"}'}, clear=True
        ):
            self.assertEqual(local_configuration(), {"PATH": "/synthetic/provider"})
            self.assertNotIn("PATH", os.environ)
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(local_configuration(), {})
        for raw in (
            "[]",
            '{"MODE":1}',
            '{"MODE":"a","MODE":"b"}',
            '{"mixedCase":"a"}',
            '"' + SECRET + '"',
            "x" * 16385,
        ):
            with self.subTest(raw=raw[:30]), patch.dict(os.environ, {key: raw}):
                with self.assertRaises(AuthError) as error:
                    local_configuration()
                self.assertNotIn(SECRET, str(error.exception))

    def test_oauth_refresh_preserves_identity_and_non_rotated_refresh_token(self):
        class Duplex:
            def __init__(self):
                self.input = frame(
                    envelope(
                        {
                            "access_token": "old",
                            "refresh_token": SECRET,
                            "account": "alice",
                        },
                        credentialType="oauth2",
                    )
                )
                self.output = io.BytesIO()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, size):
                return self.input.read(size)

            def write(self, value):
                return self.output.write(value)

            def flush(self):
                pass

        def refresh(value):
            print(SECRET)
            value["account"] = "mutated-copy"
            return {"access_token": "new", "expires_at": 9999999999}

        stream = Duplex()
        output = io.StringIO()
        adapter = make_adapter(
            "oauth2",
            refresh=refresh,
            account_id=lambda value: value["account"],
            validate=lambda value: self.assertEqual(value["account"], "alice"),
        )
        with patch.object(adapter_module, "open_pipe", return_value=stream) as pipe:
            with contextlib.redirect_stdout(output):
                self.assertEqual(adapter.main(["refresh"]), 0)
        pipe.assert_called_once_with("rwb")
        stream.output.seek(0)
        result = read_frame(stream.output)["credential"]
        self.assertEqual(result["refresh_token"], SECRET)
        self.assertEqual(result["account"], "alice")
        self.assertEqual(result["access_token"], "new")
        self.assertNotIn(SECRET, output.getvalue())

    def test_oauth_callbacks_are_opt_in(self):
        with self.assertRaises(AuthError):
            make_adapter(refresh=lambda value: value)
        for operation in ("authorize", "refresh", "revoke"):
            with self.subTest(operation=operation):
                with patch.object(adapter_module, "open_pipe") as pipe:
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(make_adapter("oauth2").main([operation]), 1)
                    pipe.assert_not_called()

    def test_credential_types_and_custom_validation(self):
        for kind, credential in (
            ("password", {"username": "alice", "password": SECRET}),
            ("bearer", {"token": SECRET}),
            ("oauth2", {"access_token": SECRET, "refresh_token": "refresh"}),
        ):
            with self.subTest(kind=kind):
                adapter = make_adapter(kind, export=lambda: credential)
                stream = io.BytesIO()
                metadata = adapter.export_credential(stream)
                self.assertNotIn(SECRET, json.dumps(metadata))
                stream.seek(0)
                self.assertEqual(adapter.read_credential(stream), credential)
                for value in ({}, None, {next(iter(credential)): ""}):
                    with self.assertRaises(AuthError):
                        adapter.read_credential(
                            frame(
                                dict(envelope(), credentialType=kind, credential=value)
                            )
                        )

        def reject(value):
            raise ValueError(SECRET)

        with self.assertRaisesRegex(AuthError, "Invalid credential payload"):
            make_adapter(validate=reject).read_credential(frame(envelope()))

    def test_rejects_envelope_confusion(self):
        for changes in (
            {"protocolVersion": True},
            {"protocolVersion": 2},
            {"connectorSlug": "other"},
            {"credentialType": "bearer"},
            {"extra": SECRET},
            {"credential": []},
        ):
            with self.subTest(changes=changes), self.assertRaises(AuthError):
                make_adapter().read_credential(frame(envelope(**changes)))

    def test_rejects_malformed_frames_before_execution(self):
        invalid = [b"", b"\x00", struct.pack("!I", 0), struct.pack("!I", 65537)]
        for raw in (b"{", b"[]", b'{"a":1,"a":2}', b'{"a":NaN}', b"\xff", b"[" * 2000):
            invalid.append(struct.pack("!I", len(raw)) + raw)
        invalid.append(struct.pack("!I", 2) + b"{")
        for data in invalid:
            with self.subTest(data=data[:20]), self.assertRaises(AuthError):
                read_frame(io.BytesIO(data))

    def test_size_limit_and_short_reads_writes(self):
        class Fragmented(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(size, 3))

            def write(self, data):
                return super().write(data[:3])

        stream = Fragmented()
        payload = {"x": "a" * (MAX_FRAME_BYTES - len(b'{"x":""}'))}
        write_frame(stream, payload)
        stream.seek(0)
        self.assertEqual(read_frame(stream), payload)
        with self.assertRaises(AuthError):
            write_frame(io.BytesIO(), {"x": payload["x"] + "a"})
        with self.assertRaises(AuthError):
            write_frame(io.BytesIO(), {"x": float("nan")})

    def test_auth_callback_noise_and_errors_are_sanitized(self):
        def noisy_export():
            print(SECRET)
            print(SECRET, file=sys.stderr)
            return {"username": "alice", "password": SECRET}

        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            make_adapter(export=noisy_export).export_credential(io.BytesIO())
            with patch.object(
                adapter_module, "open_pipe", side_effect=RuntimeError(SECRET)
            ):
                self.assertEqual(make_adapter().main(["export"]), 1)
        self.assertNotIn(SECRET, output.getvalue() + errors.getvalue())
        self.assertEqual(
            json.loads(output.getvalue())["code"], "plugin_auth_adapter_failed"
        )

    def test_provider_system_exit_cannot_print_credentials(self):
        def export():
            raise SystemExit(SECRET)

        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with patch.object(adapter_module, "open_pipe", return_value=io.BytesIO()):
                self.assertEqual(make_adapter(export=export).main(["export"]), 1)
        self.assertNotIn(SECRET, output.getvalue() + errors.getvalue())
        self.assertEqual(
            json.loads(output.getvalue())["code"], "plugin_auth_adapter_failed"
        )

    def test_rejects_standard_descriptors_and_regular_files(self):
        for fd in ("0", "1", "2", "-1", "invalid"):
            with (
                patch.dict(os.environ, {"WEGENT_PLUGIN_AUTH_FD": fd}),
                self.assertRaises(AuthError),
            ):
                open_pipe("rb")
        with open(__file__, "rb") as source:
            with (
                patch.dict(os.environ, {"WEGENT_PLUGIN_AUTH_FD": str(source.fileno())}),
                self.assertRaises(AuthError),
            ):
                open_pipe("rb")

    def test_socket_transport_rejects_ambiguity_and_truncated_capability(self):
        from types import SimpleNamespace

        for environment in (
            {"WEGENT_PLUGIN_AUTH_PORT": "5000", "WEGENT_PLUGIN_AUTH_FD": "3"},
            {"WEGENT_PLUGIN_AUTH_PORT": "5000"},
            {"WEGENT_PLUGIN_AUTH_PORT": "0"},
            {"WEGENT_PLUGIN_AUTH_PORT": "65536"},
        ):
            with patch.dict(os.environ, environment, clear=True):
                with patch(
                    "wegent_plugin_auth.transport.sys.stdin",
                    SimpleNamespace(buffer=io.BytesIO(b"short")),
                ):
                    with self.assertRaises(AuthError):
                        open_pipe("rb")

    def test_disallowed_command_never_reads_credentials(self):
        with patch.object(adapter_module, "open_pipe") as pipe:
            with contextlib.redirect_stdout(io.StringIO()):
                for args in ([], ["refresh"], ["run", "login"], ["run", "logout"]):
                    self.assertEqual(make_adapter().main(args), 1)
            pipe.assert_not_called()


class PackageTests(unittest.TestCase):
    def test_scaffold_and_vendor_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            for kind in ("password", "bearer", "oauth2"):
                plugin = tool.scaffold(parent, kind, kind)
                manifest = json.loads(
                    (plugin / ".codex-plugin/plugin.json").read_text()
                )
                self.assertEqual(manifest["name"], plugin.name)
                self.assertEqual(
                    manifest["connectors"][0]["accountAuth"]["credentialType"], kind
                )
                declaration = manifest["connectors"][0]["accountAuth"]
                self.assertEqual(
                    declaration.get("oauth2"),
                    ["authorize", "refresh", "revoke"] if kind == "oauth2" else None,
                )
                for script in (plugin / "scripts").glob("*.py"):
                    compile(script.read_text(), str(script), "exec")
                tool.bundle(plugin, check=True)
                with self.assertRaises(FileExistsError):
                    tool.scaffold(parent, kind, kind)
                (plugin / "scripts/wegent_plugin_auth/adapter.py").write_text(
                    "modified"
                )
                with self.assertRaises(ValueError):
                    tool.bundle(plugin, check=True)
            for name in ("../escape", "Bad Name", "x" * 65):
                with self.assertRaises(ValueError):
                    tool.scaffold(parent, name, "password")

    def test_zip_extracted_plugin_uses_authenticated_socket_without_source_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plugin = tool.scaffold(root / "source", "sample", "password")
            # A synthetic provider exercises the public extension surface in a child.
            (plugin / "scripts/auth_provider.py").write_text(
                """
import json
import sys
ALLOWED_COMMANDS = ("read", "fail")
def export_local():
    print("synthetic-private-secret")
    print("synthetic-private-secret", file=sys.stderr)
    return {"username": "alice", "password": "synthetic-private-secret"}
def account_id(value):
    return value["username"]
def validate(value):
    assert value["password"] == "synthetic-private-secret"
def execute(value, arguments):
    if arguments[0] == "fail":
        raise RuntimeError(value["password"])
    print(json.dumps({"account": value["username"], "command": arguments[0]}))
    return 0
"""
            )
            archive = root / "plugin.zip"
            with zipfile.ZipFile(archive, "w") as output:
                for source in plugin.rglob("*"):
                    if source.is_file():
                        output.write(source, source.relative_to(plugin))
            extracted = root / "isolated"
            with zipfile.ZipFile(archive) as package:
                package.extractall(extracted)
            command = [sys.executable, "-E", str(extracted / "scripts/account-auth.py")]

            credential = None
            for operation, expected in (("export", 0), ("read", 0), ("fail", 1)):
                with socket.socket() as listener:
                    listener.bind(("127.0.0.1", 0))
                    listener.listen(1)
                    listener.settimeout(10)
                    nonce = os.urandom(32)
                    env = dict(
                        os.environ,
                        WEGENT_PLUGIN_AUTH_PORT=str(listener.getsockname()[1]),
                    )
                    env.pop("WEGENT_PLUGIN_AUTH_FD", None)
                    arguments = (
                        ["export"] if operation == "export" else ["run", operation]
                    )
                    with subprocess.Popen(
                        command + arguments,
                        cwd=extracted,
                        env=env,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    ) as process:
                        process.stdin.write(nonce)
                        process.stdin.close()
                        process.stdin = None
                        connection, _ = listener.accept()
                        with connection:
                            connection.settimeout(10)
                            with connection.makefile("rwb") as stream:
                                self.assertEqual(stream.read(32), nonce)
                                if operation == "export":
                                    credential = make_adapter().read_credential(stream)
                                else:
                                    write_frame(stream, envelope(credential))
                        stdout, stderr = process.communicate(timeout=10)
                        self.assertEqual(process.returncode, expected, stderr)
                        self.assertNotIn(SECRET.encode(), stdout + stderr)
                        if operation == "export":
                            self.assertEqual(json.loads(stdout)["accountId"], "alice")
                        elif expected == 0:
                            self.assertEqual(
                                json.loads(stdout),
                                {"account": "alice", "command": "read"},
                            )
                        else:
                            self.assertEqual(
                                json.loads(stdout)["code"], "plugin_auth_adapter_failed"
                            )


if __name__ == "__main__":
    unittest.main()
