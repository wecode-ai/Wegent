# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Log DingTalk message structure without exposing transport credentials."""

import json
import logging
from typing import Any

from shared.utils.sensitive_data_masker import mask_sensitive_data

_CREDENTIAL_FIELDS = {
    "sessionwebhook",
    "downloadcode",
    "picturedownloadcode",
    "downloadurl",
    "accesstoken",
    "refreshtoken",
    "token",
    "appsecret",
    "clientsecret",
    "secret",
    "apikey",
    "authorization",
    "cookie",
    "password",
    "sign",
    "signature",
}


def _redact_credentials(value: Any) -> Any:
    """Preserve unknown reference fields, including JSON-encoded message bodies."""
    if isinstance(value, dict):
        return {
            key: (
                "[REDACTED]"
                if key.replace("_", "").replace("-", "").lower() in _CREDENTIAL_FIELDS
                else _redact_credentials(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_credentials(item) for item in value]
    if isinstance(value, str) and value.lstrip().startswith(("{", "[")):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return value
        return json.dumps(_redact_credentials(decoded), ensure_ascii=False)
    return value


def log_dingtalk_message(
    logger: logging.Logger, event: str, payload: dict[str, Any]
) -> None:
    """Write one searchable JSON record without mutating the original message."""
    if not logger.isEnabledFor(logging.INFO):
        return
    logger.info(
        "[DingTalkMessage] %s %s",
        event,
        json.dumps(
            mask_sensitive_data(_redact_credentials(payload)), ensure_ascii=False
        ),
    )
