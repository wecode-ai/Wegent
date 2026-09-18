# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider identifiers and opaque identities for synchronized documents."""

from __future__ import annotations

from dataclasses import dataclass

WIKI_PROVIDER_ID = "wiki"


class ExternalDocumentIdentityError(ValueError):
    """An external document identity is malformed or exceeds storage limits."""


@dataclass(frozen=True)
class ExternalSyncLocator:
    provider_id: str
    connection_id: str
    resource_id: str


def encode_external_sync_resource_id(locator: ExternalSyncLocator) -> str:
    value = f"v1:{locator.connection_id}:{locator.resource_id}"
    if len(value) > 255:
        raise ExternalDocumentIdentityError("External document identity is too long")
    return value


def decode_external_sync_resource_id(
    provider_id: str, value: str
) -> ExternalSyncLocator:
    prefix, separator, remainder = value.partition(":")
    connection_id, second_separator, resource_id = remainder.partition(":")
    if prefix != "v1" or not separator or not second_separator:
        raise ExternalDocumentIdentityError("Invalid synchronized document identity")
    if not connection_id or not resource_id:
        raise ExternalDocumentIdentityError("Invalid synchronized document identity")
    return ExternalSyncLocator(provider_id, connection_id, resource_id)
