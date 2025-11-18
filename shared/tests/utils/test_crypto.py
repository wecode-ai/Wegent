# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for shared/utils/crypto.py (migrated from test_crypto.py)
"""

import pytest

from shared.utils.crypto import encrypt_git_token, decrypt_git_token, is_token_encrypted


class TestCryptoEncryptionDecryption:
    """Test encryption and decryption functionality"""

    def test_basic_encryption_decryption(self):
        """Test basic encryption and decryption works"""
        test_token = "ghp_testtoken12345abcde"

        # Encrypt token
        encrypted = encrypt_git_token(test_token)
        assert encrypted is not None
        assert encrypted != test_token

        # Verify token is encrypted
        is_encrypted = is_token_encrypted(encrypted)
        assert is_encrypted is True

        # Decrypt token
        decrypted = decrypt_git_token(encrypted)
        assert decrypted == test_token

    def test_empty_token_encryption(self):
        """Test encryption and decryption of empty token"""
        empty_token = ""

        encrypted_empty = encrypt_git_token(empty_token)
        assert encrypted_empty == ""

        decrypted_empty = decrypt_git_token(encrypted_empty)
        assert decrypted_empty == empty_token

    def test_backward_compatibility_plain_token(self):
        """Test backward compatibility with plain (unencrypted) tokens"""
        plain_token = "plain_token_123"

        # Plain token should not be detected as encrypted
        is_plain_encrypted = is_token_encrypted(plain_token)
        assert is_plain_encrypted is False

        # Decrypting a plain token should return it as-is (fallback)
        decrypted_plain = decrypt_git_token(plain_token)
        assert decrypted_plain == plain_token

    def test_encrypted_token_format(self):
        """Test that encrypted token is base64 encoded"""
        test_token = "ghp_testtoken12345"
        encrypted = encrypt_git_token(test_token)

        # Encrypted token should be base64 encoded string
        assert isinstance(encrypted, str)
        assert len(encrypted) > 0

        # Should be different from original
        assert encrypted != test_token

    def test_multiple_encryptions_same_token(self):
        """Test that encrypting the same token produces the same result"""
        test_token = "ghp_consistent_token"

        encrypted1 = encrypt_git_token(test_token)
        encrypted2 = encrypt_git_token(test_token)

        # With fixed IV, same token should produce same encrypted result
        assert encrypted1 == encrypted2

    def test_different_tokens_different_encrypted(self):
        """Test that different tokens produce different encrypted results"""
        token1 = "ghp_token_one"
        token2 = "ghp_token_two"

        encrypted1 = encrypt_git_token(token1)
        encrypted2 = encrypt_git_token(token2)

        assert encrypted1 != encrypted2

    def test_special_characters_encryption(self):
        """Test encryption with special characters"""
        special_token = "ghp_token!@#$%^&*()_+-=[]{}|;:',.<>?/`~"

        encrypted = encrypt_git_token(special_token)
        decrypted = decrypt_git_token(encrypted)

        assert decrypted == special_token

    def test_long_token_encryption(self):
        """Test encryption of a long token"""
        long_token = "ghp_" + "a" * 200

        encrypted = encrypt_git_token(long_token)
        decrypted = decrypt_git_token(encrypted)

        assert decrypted == long_token

    def test_masked_token_handling(self):
        """Test that masked token (***) is handled specially"""
        masked_token = "***"

        encrypted = encrypt_git_token(masked_token)
        assert encrypted == "***"

        decrypted = decrypt_git_token(masked_token)
        assert decrypted == "***"

    def test_is_token_encrypted_edge_cases(self):
        """Test is_token_encrypted with edge cases"""
        # Empty string
        assert is_token_encrypted("") is False

        # None
        assert is_token_encrypted(None) is False

        # Random string (not base64)
        assert is_token_encrypted("not_encrypted_token") is False

        # Valid encrypted token
        encrypted = encrypt_git_token("test_token")
        assert is_token_encrypted(encrypted) is True
