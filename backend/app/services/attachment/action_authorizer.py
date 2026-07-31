# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral authorization hook for attachment export actions."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum

from sqlalchemy.orm import Session


class AttachmentAction(str, Enum):
    """Attachment actions that may expose a durable copy."""

    CREATE_PUBLIC_SHARE = "create_public_share"
    PREVIEW_BY_SHARE_TOKEN = "preview_by_share_token"
    DOWNLOAD_BY_SHARE_TOKEN = "download_by_share_token"
    DOWNLOAD_SHARED = "download_shared"


@dataclass(frozen=True)
class AttachmentActionContext:
    """Inputs available to a registered attachment action authorizer."""

    attachment_id: int
    action: AttachmentAction
    db: Session
    user_id: int | None = None


AttachmentActionAuthorizer = Callable[
    [AttachmentActionContext],
    Awaitable[None],
]

_authorizer: AttachmentActionAuthorizer | None = None


def register_attachment_action_authorizer(
    authorizer: AttachmentActionAuthorizer,
) -> None:
    """Register the process-wide authorizer without allowing silent replacement."""
    global _authorizer
    if _authorizer is authorizer:
        return
    if _authorizer is not None:
        raise RuntimeError("Attachment action authorizer is already registered")
    _authorizer = authorizer


async def authorize_attachment_action(context: AttachmentActionContext) -> None:
    """Authorize an attachment action, preserving OSS behavior by default."""
    if _authorizer is not None:
        await _authorizer(context)
