# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise the embedded transaction on the native filesystem without API deps."""

import importlib.util
import json
import os
import shlex
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path


def load_script_module(name):
    path = Path(__file__).resolve().parents[3] / "app/services/device" / (name + ".py")
    qualified = "app.services.device." + name
    existing = sys.modules.get(qualified)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(qualified, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[qualified] = module
    spec.loader.exec_module(module)
    return module


# These modules contain only stdlib imports and source strings. Load them
# directly so Windows CI does not install the unrelated Backend API stack.
paths = load_script_module("git_credential_paths")
platform = load_script_module("git_credential_platform")
commands = load_script_module("git_credentials_command")


class NativeGitCredentialsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name) / "device user's home"
        self.home.mkdir()
        self.workbench = self.home / "isolated workbench"
        self.root = self.workbench / "git-auth"
        self.environment = os.environ.copy()
        self.environment.update(
            HOME=str(self.home),
            USERPROFILE=str(self.home),
            WEGENT_WORKBENCH_HOME=str(self.workbench),
            GIT_CONFIG_NOSYSTEM="1",
            GIT_TERMINAL_PROMPT="0",
            XDG_CONFIG_HOME=str(self.home / ".config"),
        )
        self.native = {}
        exec(
            paths.GIT_CREDENTIAL_PATHS_SCRIPT
            + "\n"
            + platform.GIT_CREDENTIAL_PLATFORM_SCRIPT,
            self.native,
        )

    def account(self, token="synthetic-native-secret"):
        return dict(
            domain="git.example.invalid",
            host="git.example.invalid",
            provider="gitea",
            token=token,
            username="alice",
            identity_name="Alice",
            identity_email="alice@example.invalid",
        )

    def sync(self, accounts):
        environment = self.environment.copy()
        environment[commands.GIT_CREDENTIALS_SECRET_ENV] = json.dumps(
            dict(version=1, accounts=accounts)
        )
        arguments = shlex.split(commands.SYNC_GIT_CREDENTIALS_COMMAND)
        arguments[0] = sys.executable
        result = subprocess.run(
            arguments, env=environment, capture_output=True, text=True, timeout=30
        )
        self.assertEqual(result.stderr, "")
        return result, json.loads(result.stdout)

    def test_initial_update_and_clear_preserve_user_data(self):
        original = self.home / ".gitconfig"
        original.write_text("# user owned\n", encoding="utf-8")
        for token in ("synthetic-first", "synthetic-second"):
            result, payload = self.sync([self.account(token)])
            self.assertEqual(result.returncode, 0, payload)
            self.assertEqual(payload["synced_domains"], ["git.example.invalid"])
            current = self.root / "current"
            self.assertTrue(self.native["is_credential_link"](current))
            self.assertEqual(len(list((self.root / "revisions").iterdir())), 1)
            manifest = json.loads((current / "manifest.json").read_text())
            entry = manifest["credentials"]["git.example.invalid"]
            self.assertEqual((current / entry["token_file"]).read_text(), token)
            environment = self.environment.copy()
            environment["GIT_CONFIG_GLOBAL"] = str(current / "gitconfig")
            filled = subprocess.run(
                ["git", "credential", "fill"],
                input="protocol=https\nhost=git.example.invalid\n\n",
                env=environment,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(filled.returncode, 0, filled.stderr)
            self.assertIn("password=" + token, filled.stdout)
        result, payload = self.sync([])
        self.assertEqual(result.returncode, 0, payload)
        self.assertFalse(self.root.exists())
        self.assertEqual(original.read_text(), "# user owned\n")

    def test_lock_conflict_and_release(self):
        self.assertEqual(self.sync([self.account()])[0].returncode, 0)
        descriptor = self.native["open_credential_lock"](
            self.workbench / "runtime/git-auth/sync.lock"
        )
        try:
            self.native["lock_credentials"](descriptor)
            result, payload = self.sync([self.account()])
            self.assertEqual(result.returncode, 1)
            self.assertEqual(payload, {"error": "sync_in_progress"})
        finally:
            os.close(descriptor)
        self.assertEqual(self.sync([self.account()])[0].returncode, 0)

    def test_revision_publication(self):
        revisions = self.root / "revisions"
        choices = [revisions / "a", revisions / "b"]
        for revision in choices:
            revision.mkdir(parents=True)
            (revision / "marker").write_text(revision.name)
        publish = self.native["publish_credential_revision"]
        publish(self.root, choices[0])
        if os.name != "nt":
            # POSIX keeps the existing rename publication. Exercise its state
            # transitions; concurrent in-place reparse updates are Windows-only.
            for revision in choices:
                publish(self.root, revision)
                self.assertEqual(
                    (self.root / "current/marker").read_text(), revision.name
                )
            return
        started = threading.Event()
        stopped = threading.Event()
        errors = []
        reads = []

        def read_current():
            started.set()
            while not stopped.is_set():
                try:
                    value = (self.root / "current/marker").read_text()
                    if value not in {"a", "b"}:
                        errors.append(value)
                    reads.append(value)
                except OSError as error:
                    errors.append((type(error).__name__, error.errno, str(error)))

        reader = threading.Thread(target=read_current)
        reader.start()
        try:
            self.assertTrue(started.wait(5))
            for index in range(30):
                publish(self.root, choices[index % 2])
        finally:
            stopped.set()
            reader.join(5)
        self.assertFalse(reader.is_alive())
        self.assertTrue(reads)
        self.assertEqual(errors, [])

    def test_managed_link_and_unmanaged_directory_are_rejected(self):
        external = self.home / "unmanaged"
        external.mkdir()
        (external / "marker").write_text("preserve")
        self.root.mkdir(parents=True)
        (self.root / "user-file").write_text("preserve")
        result, payload = self.sync([self.account()])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload, {"error": "credential_directory_invalid"})
        (self.root / "user-file").unlink()
        self.root.rmdir()
        if os.name == "nt":
            self.root.mkdir()
            self.native["_win_set_junction"](self.root, external)
        else:
            self.root.symlink_to(external, target_is_directory=True)
        result, payload = self.sync([self.account()])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload, {"error": "credential_directory_invalid"})
        self.assertEqual((external / "marker").read_text(), "preserve")

    def test_managed_permissions(self):
        self.assertEqual(self.sync([self.account()])[0].returncode, 0)
        revision = (self.root / "current").resolve()
        for path in [self.root, revision, *revision.rglob("*")]:
            if os.name == "nt":
                self.assert_private_windows_acl(path)
            else:
                self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0)

    def assert_private_windows_acl(self, path):
        import ctypes
        from ctypes import wintypes

        function = self.native["_win_function"]
        security = self.native["_security"]
        read = function(
            security,
            "GetFileSecurityW",
            [
                wintypes.LPCWSTR,
                wintypes.DWORD,
                ctypes.c_void_p,
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
            ],
        )
        needed = wintypes.DWORD()
        read(str(path), 4, None, 0, ctypes.byref(needed))
        data = ctypes.create_string_buffer(needed.value)
        self.assertTrue(read(str(path), 4, data, needed.value, ctypes.byref(needed)))
        convert = function(
            security,
            "ConvertSecurityDescriptorToStringSecurityDescriptorW",
            [
                ctypes.c_void_p,
                wintypes.DWORD,
                wintypes.DWORD,
                ctypes.POINTER(wintypes.LPWSTR),
                ctypes.POINTER(wintypes.DWORD),
            ],
        )
        text = wintypes.LPWSTR()
        self.assertTrue(convert(data, 1, 4, ctypes.byref(text), None))
        try:
            sddl = text.value
            self.assertTrue(sddl.startswith("D:P"), sddl)
            self.assertEqual(sddl.count("(A;"), 2, sddl)
            self.assertIn(";;;SY)", sddl)
            self.assertIn(";;;" + self.native["_win_owner_sid"]() + ")", sddl)
        finally:
            self.native["_local_free"](ctypes.cast(text, ctypes.c_void_p))

    def test_native_command_length(self):
        arguments = shlex.split(commands.SYNC_GIT_CREDENTIALS_COMMAND)
        command_line = subprocess.list2cmdline(arguments)
        self.assertLess(len(command_line.encode("utf-16-le")) // 2 + 1, 32767)


if __name__ == "__main__":
    unittest.main()
