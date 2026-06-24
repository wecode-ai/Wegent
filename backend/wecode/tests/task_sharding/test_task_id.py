import pytest

from wecode.task_sharding.task_id import is_new_task_id
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    encode_user_scoped_id,
)

pytestmark = pytest.mark.unit


def test_user_scoped_id_is_new_task_id():
    task_id = encode_user_scoped_id(uid=1, seq=58)

    assert is_new_task_id(task_id) is True


def test_legacy_uuid_style_safe_integer_is_not_new_task_id():
    assert is_new_task_id(5310397443737613) is False


def test_large_legacy_auto_increment_id_is_not_new_task_id():
    assert is_new_task_id(7484077) is False
