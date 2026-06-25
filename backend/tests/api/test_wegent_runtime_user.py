# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import json

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi.testclient import TestClient

from app.models.user import User
from app.services.auth import create_task_token

DEFAULT_RUNTIME_AES_KEY = "12345678901234567890123456789012"


def test_get_wegent_runtime_user_returns_encrypted_task_user_info(
    test_client: TestClient,
    test_user: User,
    monkeypatch,
) -> None:
    monkeypatch.setenv("USER_AES_KEY", DEFAULT_RUNTIME_AES_KEY)

    token = create_task_token(
        task_id=1,
        subtask_id=2,
        user_id=test_user.id,
        user_name=test_user.user_name,
    )

    response = test_client.get(
        "/api/users/me/wegent-runtime",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    user = response.json()["user"]
    decrypted = _decrypt_embedded_iv_payload(user)
    payload = json.loads(decrypted)

    assert payload["employee_id"] == ""
    assert payload["email"] == test_user.email
    assert payload["name"] == test_user.user_name
    assert payload["uid"] == str(test_user.id)
    assert isinstance(payload["expire_at"], int)


def test_get_wegent_runtime_user_rejects_missing_token(
    test_client: TestClient,
) -> None:
    response = test_client.get("/api/users/me/wegent-runtime")

    assert response.status_code == 401


def _decrypt_embedded_iv_payload(encrypted: str) -> str:
    key = _parse_runtime_aes_key(DEFAULT_RUNTIME_AES_KEY)
    raw = base64.b64decode(encrypted)
    iv = raw[:16]
    ciphertext = raw[16:]
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    plaintext = unpadder.update(padded) + unpadder.finalize()
    return plaintext.decode("utf-8")


def _parse_runtime_aes_key(key: str) -> bytes:
    if key.startswith("base64:"):
        return base64.b64decode(key[7:], validate=True)

    return key.encode("utf-8")
