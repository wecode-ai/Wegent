"""Opt in to current locked facts while reusing an existing resource policy."""

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

from sqlalchemy.orm import Query

_current_authority: ContextVar[bool] = ContextVar(
    "current_resource_authority", default=False
)


@contextmanager
def current_resource_authority() -> Iterator[None]:
    token = _current_authority.set(True)
    try:
        yield
    finally:
        _current_authority.reset(token)


def current_authority_reads() -> bool:
    return _current_authority.get()


def authority_query(query: Query) -> Query:
    if not current_authority_reads():
        return query
    from app.services.collaboration_permissions import resource_query

    return resource_query(query, current=True)
