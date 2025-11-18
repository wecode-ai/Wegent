# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
import os
import sys

# Add shared directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))

from utils.crypto import (
    encrypt_git_token,
    decrypt_git_token,
    is_token_encrypted
)


@pytest.mark.unit
class TestGitTokenEncryption:
    """Test git token encryption and decryption"""

    def test_encrypt_decrypt_basic_token(self):
        """Test basic encryption and decryption of a token"""
        original_token = "ghp_testtoken12345abcde"

        encrypted = encrypt_git_token(original_token)
        assert encrypted != original_token
        assert len(encrypted) > 0

        decrypted = decrypt_git_token(encrypted)
        assert decrypted == original_token

    def test_encrypt_empty_token(self):
        """Test encrypting an empty token"""
        empty_token = ""

        encrypted = encrypt_git_token(empty_token)
        assert encrypted == ""

        decrypted = decrypt_git_token(encrypted)
        assert decrypted == ""

    def test_encrypt_special_mask_token(self):
        """Test encrypting the special *** mask token"""
        mask_token = "***"

        encrypted = encrypt_git_token(mask_token)
        assert encrypted == "***"

        decrypted = decrypt_git_token(encrypted)
        assert decrypted == "***"

    def test_is_token_encrypted_with_encrypted_token(self):
        """Test is_token_encrypted returns True for encrypted tokens"""
        original_token = "ghp_testtoken12345"
        encrypted = encrypt_git_token(original_token)

        assert is_token_encrypted(encrypted) is True

    def test_is_token_encrypted_with_plain_token(self):
        """Test is_token_encrypted returns False for plain tokens"""
        plain_token = "plain_token_123"

        assert is_token_encrypted(plain_token) is False

    def test_is_token_encrypted_with_empty_token(self):
        """Test is_token_encrypted returns False for empty token"""
        assert is_token_encrypted("") is False

    def test_decrypt_plain_token_backward_compatibility(self):
        """Test that decrypting a plain token returns it unchanged (backward compatibility)"""
        plain_token = "plain_token_123"

        decrypted = decrypt_git_token(plain_token)
        assert decrypted == plain_token

    def test_encrypt_decrypt_long_token(self):
        """Test encryption and decryption of a long token"""
        long_token = "ghp_" + "a" * 100

        encrypted = encrypt_git_token(long_token)
        decrypted = decrypt_git_token(encrypted)

        assert decrypted == long_token

    def test_encrypt_decrypt_with_special_characters(self):
        """Test encryption and decryption of token with special characters"""
        special_token = "token!@#$%^&*()_+-=[]{}|;:,.<>?"

        encrypted = encrypt_git_token(special_token)
        decrypted = decrypt_git_token(encrypted)

        assert decrypted == special_token

    def test_encrypt_same_token_produces_same_result(self):
        """Test that encrypting the same token twice produces the same result (same IV)"""
        token = "test_token_123"

        encrypted1 = encrypt_git_token(token)
        encrypted2 = encrypt_git_token(token)

        # With the same IV, same plaintext should produce same ciphertext
        assert encrypted1 == encrypted2

    def test_decrypt_invalid_base64_returns_original(self):
        """Test that decrypting invalid base64 returns the original value"""
        invalid_token = "not-valid-base64!@#"

        decrypted = decrypt_git_token(invalid_token)
        assert decrypted == invalid_token

    def test_encryption_uses_environment_variables(self, monkeypatch):
        """Test that encryption uses environment variables for keys"""
        # Set custom encryption keys
        custom_key = "abcdefghijklmnopqrstuvwxyz123456"  # 32 bytes
        custom_iv = "0123456789abcdef"  # 16 bytes

        monkeypatch.setenv("GIT_TOKEN_AES_KEY", custom_key)
        monkeypatch.setenv("GIT_TOKEN_AES_IV", custom_iv)

        # Reset the global key cache
        import utils.crypto as crypto_module
        crypto_module._git_token_aes_key = None
        crypto_module._git_token_aes_iv = None

        token = "test_token_with_custom_keys"
        encrypted = encrypt_git_token(token)
        decrypted = decrypt_git_token(encrypted)

        assert decrypted == token
