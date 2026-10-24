import hashlib
import io
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build


class SourceArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.content = b"pinned DWS source archive fixture"
        checksum = hashlib.sha256(self.content).hexdigest()
        pin = patch.object(build, "SOURCE_SHA256", checksum)
        pin.start()
        self.addCleanup(pin.stop)

    def test_one_verified_source_is_reused_without_platform_downloads(self) -> None:
        with patch.object(
            build.urllib.request, "urlopen", return_value=io.BytesIO(self.content)
        ) as download:
            archive = build.prepare_source_archive(self.root, None)
            for platform in ("linux", "macos", "windows"):
                destination = self.root / platform
                destination.mkdir()
                provided = destination / "source.tar.gz"
                shutil.copyfile(archive, provided)
                self.assertEqual(
                    build.prepare_source_archive(destination, provided),
                    provided.resolve(),
                )
            download.assert_called_once_with(
                "https://codeload.github.com/DingTalk-Real-AI/"
                f"dingtalk-workspace-cli/tar.gz/refs/tags/v{build.VERSION}",
                timeout=30,
            )

    def test_modified_provided_archive_is_rejected_without_downloading(self) -> None:
        provided = self.root / "source.tar.gz"
        provided.write_bytes(self.content + b"modified")
        with patch.object(build.urllib.request, "urlopen") as download:
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                build.prepare_source_archive(self.root, provided)
            download.assert_not_called()

    def test_downloaded_archive_is_verified_before_handoff(self) -> None:
        with patch.object(
            build.urllib.request, "urlopen", return_value=io.BytesIO(b"wrong source")
        ):
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                build.prepare_source_archive(self.root, None)

    def test_missing_provided_archive_is_rejected_without_downloading(self) -> None:
        with patch.object(build.urllib.request, "urlopen") as download:
            with self.assertRaises(FileNotFoundError):
                build.prepare_source_archive(self.root, self.root / "missing.tar.gz")
            download.assert_not_called()
