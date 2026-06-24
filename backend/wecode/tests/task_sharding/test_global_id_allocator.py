import pytest

from wecode.task_sharding.global_id_allocator import (
    UserScopedGlobalIdAllocator,
    allocate_subtask_id,
    allocate_task_id,
)

pytestmark = pytest.mark.unit


class FakeUserScopedFactory:
    def __init__(self, values: list[int]):
        self.values = list(values)
        self.user_ids: list[int] = []
        self.closed = False

    def next_id(self, user_id: int) -> int:
        self.user_ids.append(user_id)
        return self.values.pop(0)

    def close(self) -> None:
        self.closed = True


def test_allocator_functions_delegate_to_configured_allocator():
    allocator = UserScopedGlobalIdAllocator(FakeUserScopedFactory([11, 12]))

    assert allocate_task_id(allocator, user_id=7) == 11
    assert allocate_subtask_id(allocator, user_id=7) == 12


def test_user_scoped_allocator_passes_user_id():
    factory = FakeUserScopedFactory([100, 200])
    allocator = UserScopedGlobalIdAllocator(factory)

    assert allocate_task_id(allocator, user_id=42) == 100
    assert allocate_subtask_id(allocator, user_id=42) == 200
    assert factory.user_ids == [42, 42]


def test_user_scoped_allocator_close_delegates():
    factory = FakeUserScopedFactory([1])
    allocator = UserScopedGlobalIdAllocator(factory)
    allocator.close()
    assert factory.closed is True
