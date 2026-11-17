# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database predicate matching the persisted summary-checkpoint contract."""

from typing import Any

from sqlalchemy import and_, case, func, select, text
from sqlalchemy.orm import Session

from app.models.subtask import SubtaskRole, SubtaskStatus


def summary_checkpoint_predicate(db: Session, model: Any) -> Any:
    """Match only completed assistant chains with a literal JSON true marker."""
    if db.get_bind().dialect.name == "sqlite":
        chain = func.json_each(model.result, "$.messages_chain").table_valued(
            "value", "type"
        )
        message = case((chain.c.type == "object", chain.c.value), else_="{}")
        marker = (
            select(1)
            .select_from(chain)
            .where(
                func.json_type(message, "$.additional_kwargs") == "object",
                func.json_type(message, "$.additional_kwargs.summary_compacted")
                == "true",
            )
        )
        predicate = and_(
            func.json_type(model.result, "$.messages_chain") == "array",
            marker.exists(),
        )
    else:
        # Table names come from the mapped store model, never request input.
        result = f"{model.__table__.name}.result"
        message = f"JSON_EXTRACT({result}, CONCAT('$.messages_chain[', marker_index - 1, ']'))"
        path = "CONCAT('$.messages_chain[', marker_index - 1, '].additional_kwargs"
        kwargs = f"JSON_EXTRACT({result}, {path}'))"
        marker = f"JSON_EXTRACT({result}, {path}.summary_compacted'))"
        # A scalar lookup prevents MySQL from flattening JSON_TABLE into a
        # semijoin that sorts full result payloads or loses correlated markers.
        predicate = text(
            f"(SELECT 1 FROM JSON_TABLE("
            f"CASE WHEN JSON_TYPE({result}) = 'OBJECT' "
            f"AND JSON_TYPE(JSON_EXTRACT({result}, '$.messages_chain')) "
            f"= 'ARRAY' THEN {result} ELSE JSON_OBJECT('messages_chain', JSON_ARRAY()) "
            f"END, '$.messages_chain[*]' COLUMNS(marker_index FOR ORDINALITY)) "
            f"AS checkpoint_markers WHERE JSON_TYPE({message}) = 'OBJECT' "
            f"AND JSON_TYPE({kwargs}) = 'OBJECT' "
            f"AND JSON_TYPE({marker}) = 'BOOLEAN' "
            f"AND JSON_UNQUOTE({marker}) = 'true' LIMIT 1) = 1"
        )
    return and_(
        model.role == SubtaskRole.ASSISTANT,
        model.status == SubtaskStatus.COMPLETED,
        predicate,
    )
