# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bound subscription session reads independently of the chat history window."""

from typing import Any, Optional, Sequence

from sqlalchemy import String, and_, case, cast, func, or_
from sqlalchemy.orm import Session

SUBSCRIPTION_SESSION_LIMIT = 50


def _json_type(db: Session, document: Any, path: str) -> Any:
    if db.get_bind().dialect.name == "sqlite":
        return func.json_type(document, path)
    return func.lower(func.json_type(func.json_extract(document, path)))


def _json_truthy(db: Session, document: Any, path: str) -> Any:
    """Match Python JSON truthiness, including legacy scalar session evidence."""
    value = func.json_extract(document, path)
    kind = _json_type(db, document, path)
    if db.get_bind().dialect.name == "sqlite":
        return case(
            (kind == "true", True),
            (kind.in_(["integer", "real"]), value != 0),
            (kind == "text", func.length(value) > 0),
            (kind == "array", func.json_array_length(value) > 0),
            (kind == "object", value != "{}"),
            else_=False,
        )
    return case(
        (kind == "boolean", func.json_unquote(value) == "true"),
        (kind.in_(["integer", "double"]), value != 0),
        (kind == "string", func.length(func.json_unquote(value)) > 0),
        (kind.in_(["object", "array"]), func.json_length(value) > 0),
        else_=False,
    )


def session_evidence_predicate(db: Session, model: Any) -> Any:
    return and_(
        _json_type(db, model.result, "$") == "object",
        _json_truthy(db, model.result, "$.executor_session"),
    )


def _session_text(db: Session, model: Any, key: str) -> Any:
    """Canonicalize scalar identities like Python str, not JSON coercion."""
    kind = _json_type(db, model.result, f"$.executor_session.{key}")
    value = model.result["executor_session"][key].as_string()
    if db.get_bind().dialect.name == "sqlite":
        return case(
            (kind == "true", "True"),
            (kind == "false", "False"),
            else_=cast(value, String),
        )
    return case(
        (
            kind == "boolean",
            case((value == "true", "True"), else_="False"),
        ),
        else_=cast(value, String),
    )


def _session_identity(db: Session, model: Any) -> tuple[Any, Any, Any, Any]:
    """Preserve truthy identifier fallback and key-presence bot selection."""
    prefix = "$.executor_session"

    def text(key: str) -> Any:
        return _session_text(db, model, key)

    def identifier(camel: str, legacy: str) -> Any:
        return case(
            (_json_truthy(db, model.result, f"{prefix}.{camel}"), text(camel)),
            (_json_truthy(db, model.result, f"{prefix}.{legacy}"), text(legacy)),
            else_=None,
        )

    bot = case(
        (_json_type(db, model.result, f"{prefix}.botId").isnot(None), text("botId")),
        else_=text("bot_id"),
    )
    return (
        text("agent"),
        bot,
        identifier("sessionId", "session_id"),
        identifier("threadId", "thread_id"),
    )


def load_recent_executor_sessions(
    db: Session, model: Any, query: Any, bot_ids: Optional[Sequence[int]] = None
) -> list[dict[str, Any]]:
    """Filter bots and deduplicate sessions before applying the recovery cap."""
    prefix = "$.executor_session"
    session = model.result["executor_session"]
    identity = _session_identity(db, model)
    bot = identity[1]
    if bot_ids is not None:
        query = query.filter(
            or_(bot.is_(None), cast(bot, String).in_([str(i) for i in bot_ids]))
        )
    order = (model.message_id.desc(), model.created_at.desc(), model.id.desc())
    candidates = (
        query.filter(
            _json_type(db, model.result, "$") == "object",
            _json_type(db, model.result, prefix) == "object",
            _json_truthy(db, model.result, f"{prefix}.agent"),
            or_(
                *(
                    _json_truthy(db, model.result, f"{prefix}.{field}")
                    for field in ("sessionId", "session_id", "threadId", "thread_id")
                )
            ),
        )
        .with_entities(
            session.label("session"),
            model.message_id,
            model.created_at,
            model.id,
            func.row_number()
            .over(
                partition_by=identity,
                order_by=order,
            )
            .label("session_rank"),
        )
        .subquery()
    )
    rows = (
        db.query(candidates.c.session)
        .filter(candidates.c.session_rank == 1)
        .order_by(
            candidates.c.message_id.desc(),
            candidates.c.created_at.desc(),
            candidates.c.id.desc(),
        )
        .limit(SUBSCRIPTION_SESSION_LIMIT)
        .all()
    )
    return [row[0] for row in rows]
