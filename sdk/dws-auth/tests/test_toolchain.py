"""Pinned compiler bootstrapping must not inherit another Go installation."""

import hashlib
import io
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import toolchain


class ToolchainTests(unittest.TestCase):
    def test_installed_pinned_compiler_resolves_its_own_standard_library(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.dict(os.environ, {"GOROOT": "/older/go"}),
            patch.object(toolchain.shutil, "which", return_value="/new/go/bin/go"),
            patch.object(
                toolchain.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    [], 0, stdout=f"{toolchain.GO_VERSION}\n/new/go\n"
                ),
            ) as probe,
            patch.object(toolchain.urllib.request, "urlopen") as download,
        ):
            toolchain.ensure_go(Path(temporary))
            self.assertNotIn("GOROOT", probe.call_args.kwargs["env"])
            self.assertEqual(probe.call_args.kwargs["env"]["GOENV"], "off")
            self.assertEqual(os.environ["GOROOT"], "/new/go")
            self.assertEqual(os.environ["GOTOOLCHAIN"], "local")
            download.assert_not_called()

    def test_bootstrap_replaces_an_inherited_standard_library_root(self):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as writer:
            info = tarfile.TarInfo("go/bin/go")
            content = b"synthetic pinned compiler"
            info.size = len(content)
            info.mode = 0o755
            writer.addfile(info, io.BytesIO(content))
        data = archive.getvalue()
        release = {
            "filename": "go-test.linux-amd64.tar.gz",
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.dict(os.environ, {"GOROOT": "/older/go", "PATH": "/older/go/bin"}),
            patch.object(toolchain.shutil, "which", return_value=None),
            patch.object(toolchain.platform, "system", return_value="Linux"),
            patch.object(toolchain.platform, "machine", return_value="x86_64"),
            patch.dict(toolchain.ARCHIVES, {"linux/amd64": release}),
            patch.object(
                toolchain.urllib.request, "urlopen", return_value=io.BytesIO(data)
            ),
        ):
            root = Path(temporary)
            toolchain.ensure_go(root)
            self.assertEqual(os.environ["GOROOT"], str(root / "go"))
            self.assertEqual(
                os.environ["PATH"].split(os.pathsep)[0], str(root / "go/bin")
            )
            self.assertEqual(os.environ["GOTOOLCHAIN"], "local")
            self.assertEqual((root / "go/bin/go").read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
