"""Guard runtime cleanup flags with the prepared row and binding identity."""

from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from sqlalchemy.orm import Query, Session
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.orm.util import identity_key


def mark_prepared_runtime_bindings(
    db: Session,
    model: Any,
    query: Query,
    bindings: Mapping[int, tuple[Optional[str], Optional[str]]],
) -> int:
    """Reuse the store's task/owner query without hydrating any message payload."""
    marked = 0
    for subtask_id, (namespace, name) in bindings.items():
        updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        changed = query.filter(
            model.id == subtask_id,
            model.executor_namespace == namespace,
            model.executor_name == name,
            model.executor_deleted_at == False,
        ).update(
            {model.executor_deleted_at: True, model.updated_at: updated_at},
            synchronize_session=False,
        )
        marked += changed
        if changed:
            loaded = db.identity_map.get(
                identity_key(class_=model, ident=(subtask_id,))
            )
            if loaded is not None:
                set_committed_value(loaded, "executor_deleted_at", True)
                set_committed_value(loaded, "updated_at", updated_at)
    return marked
