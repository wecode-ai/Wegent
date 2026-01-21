# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
import sys

import pytest

# Add shared directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from utils.sensitive_data_masker import (
    SensitiveDataMasker,
    mask_sensitive_data,
    mask_string,
)


@pytest.fixture
def masker():
    """Create a SensitiveDataMasker instance for tests"""
    return SensitiveDataMasker()


@pytest.mark.unit
class TestSensitiveDataMasker:
    """Test cases for SensitiveDataMasker class"""

    def test_mask_github_token(self, masker):
        """Test masking GitHub personal access token"""
        # Note: This is a FAKE token for testing purposes only
        text = 'export GH_TOKEN="github_pat_EXAMPLE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012345678"'
        masked = masker.mask_string(text)

        # Should mask the token value
        assert (
            "EXAMPLE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012345678"
            not in masked
        )
        # Should show masked value with asterisks
        assert "****" in masked

    def test_mask_anthropic_api_key(self, masker):
        """Test masking Anthropic API key"""
        # Note: This is a FAKE key for testing purposes only
        text = "ANTHROPIC_API_KEY=sk-ant-api03-FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE1234567890"
        masked = masker.mask_string(text)

        assert (
            "sk-ant-api03-FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE1234567890"
            not in masked
        )
        assert "ANTHROPIC_API_KEY" in masked
        assert "****" in masked

    def test_mask_dict(self, masker):
        """Test masking dictionary with sensitive data"""
        data = {
            "github_token": "github_pat_FAKETOKEN1234567890ABCDEF",
            "api_key": "sk-TESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
            "normal_field": "safe_value",
            "nested": {"data": "value"},
        }

        masked = masker.mask_dict(data)

        # Sensitive values should be masked
        assert "github_pat_FAKETOKEN1234567890ABCDEF" not in str(masked)
        assert "sk-TESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890" not in str(
            masked
        )

        # Non-sensitive values should remain
        assert masked["normal_field"] == "safe_value"
        assert masked["nested"]["data"] == "value"

        # Masked fields should contain asterisks
        assert "****" in masked["github_token"]
        assert "****" in masked["api_key"]

    def test_convenience_functions(self):
        """Test convenience functions mask_sensitive_data and mask_string"""
        text = "API_KEY=sk-FAKEKEY12345678901234567890123456789012345678"
        masked_text = mask_string(text)
        assert "****" in masked_text
        assert "sk-FAKEKEY12345678901234567890123456789012345678" not in masked_text

        data = {"token": "github_pat_TESTTESTTESTTEST1234567890"}
        masked_data = mask_sensitive_data(data)
        assert "****" in str(masked_data)
        assert "github_pat_TESTTESTTESTTEST1234567890" not in str(masked_data)

    def test_empty_and_none_values(self, masker):
        """Test handling of empty and None values"""
        assert masker.mask_string(None) is None
        assert masker.mask_string("") == ""

        assert masker.mask_dict({}) == {}
        assert masker.mask_list([]) == []

        data = {"field": None}
        masked = masker.mask_dict(data)
        assert masked["field"] is None

    def test_no_false_positive_on_file_paths(self, masker):
        """Test that file paths are not incorrectly masked"""
        # Common file path patterns that should NOT be masked
        test_cases = [
            "/workspace/11540/Wegent/noticecenter-serv/src/main/java/com/weibo/api/motan/core/push/core/DebugPolicy.java",
            "/workspace/11540/Wegent/features/tasks/components/ChatArea.tsx",
            "src/main/java/com/example/MyClass.java",
            "/usr/local/bin/some-executable-file",
            "/home/user/Documents/my-project/file.txt",
            "C:\\Users\\Admin\\Desktop\\project\\src\\main.py",
        ]

        for path in test_cases:
            masked = masker.mask_string(path)
            # Path should remain unchanged (no asterisks added)
            assert (
                path == masked
            ), f"File path '{path}' was incorrectly masked to '{masked}'"

    def test_no_false_positive_on_urls(self, masker):
        """Test that URLs without credentials are not masked"""
        test_cases = [
            "https://github.com/wecode-ai/Wegent.git",
            "http://example.com/api/v1/users",
            "https://api.example.com/endpoint?param=value",
        ]

        for url in test_cases:
            masked = masker.mask_string(url)
            # URL should remain unchanged (no asterisks added)
            assert url == masked, f"URL '{url}' was incorrectly masked to '{masked}'"
