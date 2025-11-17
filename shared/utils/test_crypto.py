#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Test script for the crypto utilities
"""

import os
import sys
import logging

# Add project root to path (2 levels up from this script)
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.abspath(os.path.join(current_dir, "../.."))
sys.path.insert(0, project_root)
print(f"Added {project_root} to Python path")

from shared.utils.crypto import encrypt_git_token, decrypt_git_token, is_token_encrypted

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

def test_encryption_decryption():
    """Test the encryption and decryption functionality"""

    # Test case 1: Basic encryption/decryption
    test_token = "ghp_testtoken12345abcde"
    logger.info(f"Original token: {test_token}")

    # Encrypt token
    encrypted = encrypt_git_token(test_token)
    logger.info(f"Encrypted token: {encrypted}")

    # Verify token is encrypted
    is_encrypted = is_token_encrypted(encrypted)
    logger.info(f"Is encrypted: {is_encrypted}")

    # Decrypt token
    decrypted = decrypt_git_token(encrypted)
    logger.info(f"Decrypted token: {decrypted}")

    # Verify decryption success
    assert decrypted == test_token, "Decryption failed, tokens don't match!"
    logger.info("Test case 1 passed: Basic encryption/decryption works")

    # Test case 2: Empty token
    empty_token = ""
    encrypted_empty = encrypt_git_token(empty_token)
    logger.info(f"Encrypted empty token: {encrypted_empty}")
    decrypted_empty = decrypt_git_token(encrypted_empty)
    assert decrypted_empty == empty_token, "Empty token test failed!"
    logger.info("Test case 2 passed: Empty token handling works")

    # Test case 3: Backward compatibility (handle unencrypted token)
    plain_token = "plain_token_123"
    is_plain_encrypted = is_token_encrypted(plain_token)
    logger.info(f"Is plain token encrypted: {is_plain_encrypted}")
    decrypted_plain = decrypt_git_token(plain_token)
    assert decrypted_plain == plain_token, "Plain token compatibility failed!"
    logger.info("Test case 3 passed: Backward compatibility works")

    logger.info("All tests passed!")

if __name__ == "__main__":
    test_encryption_decryption()