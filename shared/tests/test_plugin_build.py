"""Behavior tests for declared builds; also vendored into plugin CI."""

import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from shared import plugin_build

BUILDER = """import argparse, os, zipfile
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--plugin'); p.add_argument('--output'); a=p.parse_args()
assert 'WEWORK_PLUGIN_RELEASE_TOKEN' not in os.environ
root=Path(a.plugin)
with zipfile.ZipFile(a.output,'w') as z:
    for f in sorted(root.rglob('*')):
        if f.is_file():
            i=zipfile.ZipInfo(f.relative_to(root).as_posix()); i.create_system=3
            i.external_attr=(0o755 if f.stat().st_mode & 0o111 else 0o644)<<16
            z.writestr(i,f.read_bytes())
    z.writestr('scripts/native/fixture.bin',b'compiled fixture')
"""


class DeclaredBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        (self.source / ".wework-build").mkdir(parents=True)
        self.declaration = {
            "schemaVersion": 1,
            "entrypoint": ".wework-build/build.py",
            "outputs": ["scripts/native"],
        }
        (self.source / ".wework-build.json").write_text(json.dumps(self.declaration))
        (self.source / ".wework-build/build.py").write_text(BUILDER)
        (self.source / ".codex-plugin").mkdir()
        (self.source / ".codex-plugin/plugin.json").write_text(
            json.dumps(
                {"name": "fixture", "version": "1.0.0", "description": "build test"}
            )
        )
        self.output = self.root / "plugin.zip"

    def test_build_preserves_source_and_scrubs_release_credentials(self):
        before = plugin_build.read_source(self.source)
        with patch.dict(
            os.environ, {"WEWORK_PLUGIN_RELEASE_TOKEN": "synthetic-secret"}
        ):
            self.assertTrue(plugin_build.run_build(self.source, self.output))
        self.assertEqual(before, plugin_build.read_source(self.source))
        built = plugin_build.archive_files(self.output)
        self.assertEqual(built["scripts/native/fixture.bin"][0], b"compiled fixture")
        self.assertEqual({p: built[p] for p in before}, before)

    def test_source_without_declaration_needs_no_compiler(self):
        (self.source / ".wework-build.json").unlink()
        self.assertFalse(plugin_build.run_build(self.source, self.output))
        self.assertFalse(self.output.exists())

    def test_build_cannot_modify_reviewed_source(self):
        script = self.source / ".wework-build/build.py"
        script.write_text(
            BUILDER.replace(
                "root=Path(a.plugin)",
                "root=Path(a.plugin); (root/'.codex-plugin/plugin.json').write_text('{}')",
            )
        )
        self.output.write_bytes(b"previous artifact")
        with self.assertRaisesRegex(ValueError, "changed reviewed source"):
            plugin_build.run_build(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"previous artifact")

    def test_missing_generated_output_fails(self):
        script = self.source / ".wework-build/build.py"
        script.write_text(
            BUILDER.replace(
                "    z.writestr('scripts/native/fixture.bin',b'compiled fixture')", ""
            )
        )
        with self.assertRaisesRegex(ValueError, "output is missing"):
            plugin_build.run_build(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_checked_in_generated_output_fails(self):
        native = self.source / "scripts/native"
        native.mkdir(parents=True)
        (native / "old").write_bytes(b"stale")
        with self.assertRaisesRegex(ValueError, "must not be checked into source"):
            plugin_build.run_build(self.source, self.output)

    def test_unsafe_or_overlapping_declarations_fail(self):
        for outputs in [
            ["../external"],
            ["scripts"],
            ["scripts/native", "scripts/native/other"],
        ]:
            with self.subTest(outputs=outputs):
                value = {**self.declaration, "outputs": outputs}
                with self.assertRaises(ValueError):
                    plugin_build.declaration(
                        {
                            ".wework-build.json": json.dumps(value).encode(),
                            ".wework-build/build.py": b"",
                        }
                    )

    def test_source_symlink_fails_before_build(self):
        (self.source / "external").symlink_to(self.root / "missing")
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            plugin_build.run_build(self.source, self.output)

    @unittest.skipUnless(os.name == "posix", "POSIX executable permissions")
    def test_extracted_native_entry_keeps_executable_permission(self):
        import subprocess

        with zipfile.ZipFile(self.output, "w") as archive:
            entry = zipfile.ZipInfo("scripts/native/fixture")
            entry.external_attr = 0o100755 << 16
            archive.writestr(entry, b"#!/bin/sh\nexit 0\n")
        destination = self.root / "extracted"
        plugin_build.extract_archive(self.output, destination)
        subprocess.run([str(destination / "scripts/native/fixture")], check=True)


if __name__ == "__main__":
    unittest.main()
