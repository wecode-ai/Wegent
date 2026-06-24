from __future__ import annotations

from typing import Protocol


class GlobalIdAllocator(Protocol):
    def allocate_task_id(self, user_id: int) -> int:
        pass

    def allocate_subtask_id(self, user_id: int) -> int:
        pass


class UserScopedGlobalIdAllocator:
    """Allocator backed by UserScopedIdFactory (Redis INCR + uid encoding)."""

    def __init__(self, user_scoped_factory) -> None:
        self.user_scoped_factory = user_scoped_factory

    def allocate_task_id(self, user_id: int) -> int:
        return self.user_scoped_factory.next_id(user_id)

    def allocate_subtask_id(self, user_id: int) -> int:
        return self.user_scoped_factory.next_id(user_id)

    def close(self) -> None:
        close = getattr(self.user_scoped_factory, "close", None)
        if close is not None:
            close()


def allocate_task_id(allocator: GlobalIdAllocator, user_id: int = 0) -> int:
    return allocator.allocate_task_id(user_id)


def allocate_subtask_id(allocator: GlobalIdAllocator, user_id: int = 0) -> int:
    return allocator.allocate_subtask_id(user_id)
