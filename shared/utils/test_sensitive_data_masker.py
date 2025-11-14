# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for sensitive_data_masker module
"""

import unittest
from sensitive_data_masker import SensitiveDataMasker, mask_sensitive_data, mask_string


class TestSensitiveDataMasker(unittest.TestCase):
    """Test cases for SensitiveDataMasker class"""

    def setUp(self):
        """Set up test fixtures"""
        self.masker = SensitiveDataMasker()

    def test_mask_github_token(self):
        """Test masking GitHub personal access token"""
        # Note: This is a FAKE token for testing purposes only
        text = "export GH_TOKEN=\"github_pat_EXAMPLE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012345678\""
        masked = self.masker.mask_string(text)

        # Should mask the token value
        self.assertNotIn("EXAMPLE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012345678", masked)
        # Should show masked value with asterisks
        self.assertIn("****", masked)

    def test_mask_anthropic_api_key(self):
        """Test masking Anthropic API key"""
        # Note: This is a FAKE key for testing purposes only
        text = "ANTHROPIC_API_KEY=sk-ant-api03-FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE1234567890"
        masked = self.masker.mask_string(text)

        self.assertNotIn("sk-ant-api03-FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE1234567890", masked)
        self.assertIn("ANTHROPIC_API_KEY", masked)
        self.assertIn("****", masked)

    def test_mask_dict(self):
        """Test masking dictionary with sensitive data"""
        data = {
            "github_token": "github_pat_FAKETOKEN1234567890ABCDEF",
            "api_key": "sk-TESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
            "normal_field": "safe_value",
            "nested": {
                "data": "value"
            }
        }

        masked = self.masker.mask_dict(data)

        # Sensitive values should be masked
        self.assertNotIn("github_pat_FAKETOKEN1234567890ABCDEF", str(masked))
        self.assertNotIn("sk-TESTKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", str(masked))

        # Non-sensitive values should remain
        self.assertEqual(masked["normal_field"], "safe_value")
        self.assertEqual(masked["nested"]["data"], "value")

        # Masked fields should contain asterisks
        self.assertIn("****", masked["github_token"])
        self.assertIn("****", masked["api_key"])

    def test_convenience_functions(self):
        """Test convenience functions mask_sensitive_data and mask_string"""
        text = "API_KEY=sk-FAKEKEY12345678901234567890123456789012345678"
        masked_text = mask_string(text)
        self.assertIn("****", masked_text)
        self.assertNotIn("sk-FAKEKEY12345678901234567890123456789012345678", masked_text)

        data = {"token": "github_pat_TESTTESTTESTTEST1234567890"}
        masked_data = mask_sensitive_data(data)
        self.assertIn("****", str(masked_data))
        self.assertNotIn("github_pat_TESTTESTTESTTEST1234567890", str(masked_data))

    def test_empty_and_none_values(self):
        """Test handling of empty and None values"""
        self.assertIsNone(self.masker.mask_string(None))
        self.assertEqual(self.masker.mask_string(""), "")

        self.assertEqual(self.masker.mask_dict({}), {})
        self.assertEqual(self.masker.mask_list([]), [])

        data = {"field": None}
        masked = self.masker.mask_dict(data)
        self.assertIsNone(masked["field"])


if __name__ == '__main__':
    unittest.main()
