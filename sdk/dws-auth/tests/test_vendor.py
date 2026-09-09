import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vendor


class BuildVendorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repository = Path(self.temporary.name)

    def test_bundle_has_all_build_inputs_and_detects_drift(self):
        vendor.bundle(self.repository)
        vendor.bundle(self.repository, check=True)
        target = self.repository / "plugins/dingtalk/.wework-build"
        self.assertTrue((target / "plugin-auth/tool.py").is_file())
        self.assertTrue((target / "plugin-auth-go/adapter.go").is_file())
        self.assertTrue((target / "dws-auth/auth-overlay/wegent_transfer.go").is_file())
        (target / "plugin-auth-go/adapter.go").write_text("modified")
        with self.assertRaisesRegex(ValueError, "differ"):
            vendor.bundle(self.repository, check=True)

    def test_unknown_files_are_preserved_and_rejected(self):
        vendor.bundle(self.repository)
        unknown = self.repository / "plugins/dingtalk/.wework-build/hand-written.txt"
        unknown.write_text("keep")
        with self.assertRaisesRegex(ValueError, "unexpected"):
            vendor.bundle(self.repository)
        self.assertEqual(unknown.read_text(), "keep")

    def test_inventory_is_independent_of_platform_path_order(self):
        files = vendor.source_files()
        vendor.bundle(self.repository)
        with patch.object(
            vendor, "source_files", return_value=dict(reversed(files.items()))
        ):
            vendor.bundle(self.repository, check=True)

    def test_symlink_destination_is_rejected(self):
        (self.repository / "plugins/dingtalk").mkdir(parents=True, exist_ok=True)
        (self.repository / "plugins/dingtalk/.wework-build").symlink_to(
            self.repository / "missing", target_is_directory=True
        )
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            vendor.bundle(self.repository)


if __name__ == "__main__":
    unittest.main()
