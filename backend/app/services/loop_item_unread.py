# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Per-user unread projection stored inside LoopItem metadata."""

from __future__ import annotations

from sqlalchemy import Integer, case, cast, func
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem

CONTENT_REVISION_KEY = "content_revision"
READ_REVISIONS_KEY = "read_revisions"
INITIAL_CONTENT_REVISION = 1


def content_revision(metadata: object) -> int:
    if not isinstance(metadata, dict):
        return INITIAL_CONTENT_REVISION
    value = metadata.get(CONTENT_REVISION_KEY)
    return value if isinstance(value, int) and value >= INITIAL_CONTENT_REVISION else 1


def is_unread(metadata: object, user_id: int) -> bool:
    revision = content_revision(metadata)
    if not isinstance(metadata, dict):
        return True
    read_revisions = metadata.get(READ_REVISIONS_KEY)
    if not isinstance(read_revisions, dict):
        return True
    read_revision = read_revisions.get(str(user_id))
    return not isinstance(read_revision, int) or read_revision < revision


def initialize_content_revision(metadata: object, actor_user_id: int) -> dict:
    next_metadata = dict(metadata) if isinstance(metadata, dict) else {}
    next_metadata[CONTENT_REVISION_KEY] = INITIAL_CONTENT_REVISION
    next_metadata[READ_REVISIONS_KEY] = {str(actor_user_id): INITIAL_CONTENT_REVISION}
    return next_metadata


def advance_content_revision(
    metadata: object, *, actor_user_id: int | None = None
) -> dict:
    next_metadata = dict(metadata) if isinstance(metadata, dict) else {}
    revision = content_revision(next_metadata) + 1
    next_metadata[CONTENT_REVISION_KEY] = revision
    read_revisions = next_metadata.get(READ_REVISIONS_KEY)
    next_read_revisions = (
        dict(read_revisions) if isinstance(read_revisions, dict) else {}
    )
    if actor_user_id is not None:
        next_read_revisions[str(actor_user_id)] = revision
    next_metadata[READ_REVISIONS_KEY] = next_read_revisions
    return next_metadata


def _mysql_read_revision_expression(metadata: object, revision_path: str) -> object:
    """Return a JSON_SET-compatible numeric revision expression for MySQL."""

    extracted = func.json_unquote(func.json_extract(metadata, revision_path))
    return cast(func.coalesce(extracted, str(INITIAL_CONTENT_REVISION)), Integer)


def _mysql_mark_read_expression(metadata: object, user_id: int) -> object:
    """Build one atomic JSON expression that also repairs legacy metadata."""

    read_revisions_path = f"$.{READ_REVISIONS_KEY}"
    user_path = f'{read_revisions_path}."{user_id}"'
    revision_path = f"$.{CONTENT_REVISION_KEY}"
    read_revisions = func.json_extract(metadata, read_revisions_path)
    read_revisions_object = case(
        (func.json_type(read_revisions) == "OBJECT", read_revisions),
        else_=func.json_object(),
    )
    return func.json_set(
        metadata,
        read_revisions_path,
        read_revisions_object,
        user_path,
        _mysql_read_revision_expression(metadata, revision_path),
    )


def mark_loop_item_read(db: Session, *, item_id: str, user_id: int) -> None:
    """Atomically advance one user's read cursor without touching item version/time."""

    path = f'$.{READ_REVISIONS_KEY}."{user_id}"'
    revision_path = f"$.{CONTENT_REVISION_KEY}"
    dialect = db.get_bind().dialect.name
    if dialect == "mysql":
        metadata = func.coalesce(LoopItem.metadata_json, func.json_object())
        next_metadata = _mysql_mark_read_expression(metadata, user_id)
    else:
        metadata = func.coalesce(LoopItem.metadata_json, "{}")
        revision = func.coalesce(
            func.json_extract(metadata, revision_path), INITIAL_CONTENT_REVISION
        )
        next_metadata = func.json_set(metadata, path, revision)

    db.query(LoopItem).filter(LoopItem.id == item_id).update(
        {
            LoopItem.metadata_json: next_metadata,
            LoopItem.updated_at: LoopItem.updated_at,
        },
        synchronize_session=False,
    )
