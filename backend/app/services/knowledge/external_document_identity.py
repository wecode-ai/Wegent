# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider identifiers and opaque identities for synchronized documents."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

WIKI_PROVIDER_ID = "wiki"


class ExternalDocumentIdentityError(ValueError):
    """An external document identity is malformed or exceeds storage limits."""


@dataclass(frozen=True)
class ExternalSyncLocator:
    provider_id: str
    connection_id: str
    resource_id: str
    resource_kind: str = ""
    identity_version: str = "v1"


def encode_external_sync_resource_id(locator: ExternalSyncLocator) -> str:
    if locator.identity_version == "v1":
        value = f"v1:{locator.connection_id}:{locator.resource_id}"
    elif locator.identity_version == "v2":
        if not locator.resource_kind or not locator.resource_id:
            raise ExternalDocumentIdentityError(
                "Invalid synchronized document identity"
            )
        digest = hashlib.sha256(locator.resource_id.encode("utf-8")).hexdigest()
        value = f"v2:{locator.connection_id}:{locator.resource_kind}:{digest}"
    else:
        raise ExternalDocumentIdentityError("Invalid synchronized document identity")
    if len(value) > 255:
        raise ExternalDocumentIdentityError("External document identity is too long")
    return value


def decode_external_sync_resource_id(
    provider_id: str, value: str
) -> ExternalSyncLocator:
    prefix, separator, remainder = value.partition(":")
    if not separator:
        raise ExternalDocumentIdentityError("Invalid synchronized document identity")
    if prefix == "v1":
        connection_id, second_separator, resource_id = remainder.partition(":")
        if not second_separator or not connection_id or not resource_id:
            raise ExternalDocumentIdentityError(
                "Invalid synchronized document identity"
            )
        return ExternalSyncLocator(provider_id, connection_id, resource_id)
    if prefix != "v2":
        raise ExternalDocumentIdentityError("Invalid synchronized document identity")
    parts = remainder.split(":")
    if len(parts) != 3:
        raise ExternalDocumentIdentityError("Invalid synchronized document identity")
    connection_id, resource_kind, digest = parts
    if (
        not connection_id
        or resource_kind not in {"file", "page"}
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        raise ExternalDocumentIdentityError("Invalid synchronized document identity")
    return ExternalSyncLocator(
        provider_id,
        connection_id,
        digest,
        resource_kind=resource_kind,
        identity_version="v2",
    )
