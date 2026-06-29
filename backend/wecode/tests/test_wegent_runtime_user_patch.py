# SPDX-FileCopyrightText: 2026 Weibo, Inc.
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


def test_patched_current_user_keeps_fastapi_signature(
    test_client: TestClient,
    test_token: str,
    test_user: User,
) -> None:
    response = test_client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    assert response.status_code == 200
    assert response.json()["user_name"] == test_user.user_name


def test_patched_wegent_runtime_user_uses_weibo_uid_and_employee_id(
    test_client: TestClient,
    test_user: User,
    monkeypatch,
) -> None:
    monkeypatch.setenv("USER_AES_KEY", DEFAULT_RUNTIME_AES_KEY)
    test_user.preferences = json.dumps(
        {
            "company_profile": {
                "employee_id": "220750",
                "name": "刘彦生",
            },
            "weibo_binding": {
                "uid": "3853506976",
                "screen_name": "飞飞喷浆机",
            },
        },
        ensure_ascii=False,
    )

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
    payload = json.loads(_decrypt_embedded_iv_payload(response.json()["user"]))
    assert payload["employee_id"] == "220750"
    assert payload["name"] == "刘彦生"
    assert payload["uid"] == "3853506976"


def _decrypt_embedded_iv_payload(encrypted: str) -> str:
    raw = base64.b64decode(encrypted)
    iv = raw[:16]
    ciphertext = raw[16:]
    cipher = Cipher(
        algorithms.AES(DEFAULT_RUNTIME_AES_KEY.encode("utf-8")),
        modes.CBC(iv),
        backend=default_backend(),
    )
    decryptor = cipher.decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    plaintext = unpadder.update(padded) + unpadder.finalize()
    return plaintext.decode("utf-8")
