import hashlib
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import package
import verify


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.plugin = self.root / "dingtalk"
        (self.plugin / ".codex-plugin").mkdir(parents=True)
        (self.plugin / "scripts").mkdir()
        self.manifest = self.plugin / ".codex-plugin/plugin.json"
        self.manifest.write_text(
            json.dumps(
                {
                    "name": "dingtalk",
                    "description": "钉钉认证打包",
                    "connectors": [
                        {"slug": "dingtalk", "accountAuth": {"exportMode": "exclusive"}}
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (self.plugin / "scripts/account-auth.py").write_bytes(
            (package.ROOT / "entry.py").read_bytes()
        )
        self.output = self.root / "plugin.zip"
        source = patch.object(
            package, "prepare_source_archive", return_value=self.root / "source.tar.gz"
        )
        toolchain = patch.object(package, "ensure_go")
        toolchain.start()
        self.addCleanup(toolchain.stop)
        source.start()
        self.addCleanup(source.stop)

    def fake_build(self, command, **kwargs):
        if "--output" not in command:
            return
        environment = kwargs["env"]
        target = environment["GOOS"] + "/" + environment["GOARCH"]
        binary = Path(command[command.index("--output") + 1])
        if environment["GOOS"] == "windows":
            binary = binary.with_suffix(".exe")
        binary.parent.mkdir(parents=True)
        binary.write_bytes(target.encode())
        metadata = {
            "target": target,
            "nativeProtocolVersion": 1,
            "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        }
        binary.with_name(binary.name + ".json").write_text(json.dumps(metadata))
        for suffix in ("LICENSE", "NOTICE"):
            binary.with_name(binary.name + "." + suffix).write_text("test fixture")

    def test_all_targets_are_checked_before_packaging_and_source_stays_unchanged(self):
        original = self.manifest.read_bytes()
        with (
            patch.object(package.subprocess, "run", side_effect=self.fake_build),
            patch.object(package, "verify_native_entry") as native,
        ):
            package.assemble(self.plugin, self.output, None)
        native.assert_called_once()
        self.assertEqual(self.manifest.read_bytes(), original)
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(
                archive.read("scripts/account-auth.py"),
                (package.ROOT / "entry.py").read_bytes(),
            )
            manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
            self.assertEqual(
                manifest["connectors"][0]["accountAuth"]["exportMode"], "exclusive"
            )
            for target in package.TARGETS:
                prefix = "scripts/native/" + target.replace("/", "-") + "/"
                self.assertEqual(
                    sum(name.startswith(prefix) for name in archive.namelist()), 4
                )

    def test_utf8_manifest_does_not_depend_on_the_windows_code_page(self):
        read_text = Path.read_text

        def legacy_read(path, *args, **kwargs):
            return read_text(path, *args, **{"encoding": "cp1252", **kwargs})

        with (
            patch.object(Path, "read_text", autospec=True, side_effect=legacy_read),
            patch.object(package.subprocess, "run", side_effect=self.fake_build),
            patch.object(package, "verify_native_entry"),
        ):
            package.assemble(self.plugin, self.output, None)
        with zipfile.ZipFile(self.output) as archive:
            manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
            self.assertEqual(manifest["description"], "钉钉认证打包")

    def test_symlinks_are_rejected_without_following_the_target(self):
        (self.plugin / "scripts/external").symlink_to(
            self.root / "missing-external-file"
        )
        with patch.object(package.subprocess, "run") as build:
            with self.assertRaisesRegex(ValueError, "links or private state"):
                package.assemble(self.plugin, self.output, None)
        build.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_package_digest_is_reproducible_across_source_timestamps(self):
        with (
            patch.object(package.subprocess, "run", side_effect=self.fake_build),
            patch.object(package, "verify_native_entry"),
        ):
            package.assemble(self.plugin, self.output, None)
            original = self.output.read_bytes()
            os.utime(self.manifest, (1_700_000_000, 1_700_000_000))
            package.assemble(self.plugin, self.output, None)
        self.assertEqual(self.output.read_bytes(), original)
        expected = hashlib.sha256(original).hexdigest()
        self.assertEqual(
            self.output.with_name("plugin.zip.sha256").read_text(),
            expected + "  plugin.zip\n",
        )

    def test_manifest_symlink_is_rejected_before_reading_json(self):
        self.manifest.unlink()
        self.manifest.symlink_to(self.root / "not-a-manifest")
        with self.assertRaisesRegex(ValueError, "links or private state"):
            package.assemble(self.plugin, self.output, None)

    def test_private_state_is_rejected_before_build(self):
        (self.plugin / ".env").write_text("synthetic fixture")
        with patch.object(package.subprocess, "run") as build:
            with self.assertRaisesRegex(ValueError, "links or private state"):
                package.assemble(self.plugin, self.output, None)
        build.assert_not_called()

    def test_native_verification_failure_never_replaces_previous_artifact(self):
        self.output.write_bytes(b"previous artifact")
        with (
            patch.object(package.subprocess, "run", side_effect=self.fake_build),
            patch.object(
                package,
                "verify_native_entry",
                side_effect=ValueError("native entry failed"),
            ),
        ):
            with self.assertRaisesRegex(ValueError, "native entry failed"):
                package.assemble(self.plugin, self.output, None)
        self.assertEqual(self.output.read_bytes(), b"previous artifact")

    def test_binary_tampering_is_rejected(self):
        binary = self.plugin / "scripts/native/linux-amd64/dws-account-auth"
        self.fake_build(
            ["--output", str(binary)], env={"GOOS": "linux", "GOARCH": "amd64"}
        )
        binary.write_bytes(b"changed binary")
        with self.assertRaisesRegex(ValueError, "provenance mismatch"):
            verify.verify_artifacts(self.plugin, ("linux/amd64",))


class VerificationStateTests(unittest.TestCase):
    def invoke_with_state(self, state):
        def invoke(plugin, home, credential, connector):
            (home / ".cache/rosetta").mkdir(parents=True, exist_ok=True)
            if state == "file":
                (home / ".cache/rosetta/state").write_bytes(b"synthetic")
            elif state == "provider":
                (home / ".dws").mkdir(exist_ok=True)
            accepted = connector == "dingtalk" and "refresh_token" not in credential
            payload = {
                "authenticated": True,
                "accountId": "synthetic-corp:synthetic-user",
            }
            return verify.subprocess.CompletedProcess(
                [],
                0 if accepted else 1,
                json.dumps(payload if accepted else {}).encode(),
                b"",
            )

        return invoke

    def test_empty_emulator_directories_do_not_count_as_provider_state(self):
        with patch.object(
            verify, "invoke", side_effect=self.invoke_with_state("empty")
        ):
            verify.verify_native_entry(Path("unused-synthetic-plugin"))

    def test_files_and_provider_directories_are_still_rejected(self):
        for state in ("file", "provider"):
            with (
                self.subTest(state=state),
                patch.object(
                    verify, "invoke", side_effect=self.invoke_with_state(state)
                ),
            ):
                with self.assertRaisesRegex(ValueError, "local account state"):
                    verify.verify_native_entry(Path("unused-synthetic-plugin"))


if __name__ == "__main__":
    unittest.main()
