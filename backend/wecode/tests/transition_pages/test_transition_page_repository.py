import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from wecode.service.transition_pages.constants import (
    ALLOWED_ITEM_TYPES,
    ALLOWED_STATUSES,
    ITEM_BLOCK,
    ITEM_GROUP,
    ITEM_GROUP_MEMBER,
    ITEM_OVERRIDE,
    ITEM_PAGE,
    ITEM_USER_CONTENT,
    STATUS_ARCHIVED,
    STATUS_DRAFT,
    STATUS_PUBLISHED,
    page_global_key,
    user_key,
)
from wecode.service.transition_pages.repository import TransitionPageRepository


@pytest.mark.unit
def test_repository_creates_item_with_global_key(test_db: Session):
    repo = TransitionPageRepository(test_db)

    item = repo.create_item(
        "page_1",
        ITEM_BLOCK,
        "block-hero",
        {"title": "Hero"},
        global_key=page_global_key("landing"),
        sort_order=10,
        user_id=42,
    )

    assert item.id is not None
    assert item.page_id == "page_1"
    assert item.type == ITEM_BLOCK
    assert item.key == "block-hero"
    assert item.global_key == page_global_key("landing")
    assert item.sort_order == 10
    assert item.created_by == 42
    assert item.updated_by == 42


@pytest.mark.unit
def test_repository_lists_items_by_type_sorted_by_sort_order(test_db: Session):
    repo = TransitionPageRepository(test_db)
    repo.upsert_item("page_1", ITEM_BLOCK, "b2", {"title": "B"}, sort_order=20)
    repo.upsert_item("page_1", ITEM_BLOCK, "b1", {"title": "A"}, sort_order=10)

    items = repo.list_items("page_1", ITEM_BLOCK)

    assert [item.key for item in items] == ["b1", "b2"]


@pytest.mark.unit
def test_constants_expose_allowed_item_types():
    assert ALLOWED_ITEM_TYPES == {
        ITEM_PAGE,
        ITEM_GROUP,
        ITEM_GROUP_MEMBER,
        ITEM_BLOCK,
        ITEM_USER_CONTENT,
        ITEM_OVERRIDE,
    }


@pytest.mark.unit
def test_constants_expose_allowed_statuses():
    assert ALLOWED_STATUSES == {
        STATUS_DRAFT,
        STATUS_PUBLISHED,
        STATUS_ARCHIVED,
    }


@pytest.mark.unit
def test_repository_fetches_current_user_member_by_key(test_db: Session):
    repo = TransitionPageRepository(test_db)
    repo.create_item(
        "page_1",
        ITEM_GROUP_MEMBER,
        user_key(123),
        {"user_id": 123, "group_key": "group-a"},
    )

    item = repo.get_user_member("page_1", 123)

    assert item is not None
    assert item.key == user_key(123)
    assert item.data_json == {"user_id": 123, "group_key": "group-a"}


@pytest.mark.unit
def test_repository_upsert_updates_existing_item_fields(test_db: Session):
    repo = TransitionPageRepository(test_db)

    created = repo.create_item(
        "page_1",
        ITEM_BLOCK,
        "block-hero",
        {"title": "Hero", "version": 1},
        global_key=page_global_key("landing"),
        parent_key="parent-a",
        sort_order=10,
        user_id=1,
    )

    updated = repo.upsert_item(
        "page_1",
        ITEM_BLOCK,
        "block-hero",
        {"title": "Updated", "version": 2},
        global_key=page_global_key("landing-v2"),
        parent_key="parent-b",
        sort_order=25,
        user_id=99,
    )

    assert updated.id == created.id
    assert updated.data_json == {"title": "Updated", "version": 2}
    assert updated.global_key == page_global_key("landing-v2")
    assert updated.parent_key == "parent-b"
    assert updated.sort_order == 25
    assert updated.updated_by == 99


@pytest.mark.unit
def test_repository_delete_page_only_removes_matching_page_items(test_db: Session):
    repo = TransitionPageRepository(test_db)
    repo.create_item("page_1", ITEM_BLOCK, "b1", {"title": "A"}, sort_order=10)
    repo.create_item("page_1", ITEM_BLOCK, "b2", {"title": "B"}, sort_order=20)
    repo.create_item("page_2", ITEM_BLOCK, "b3", {"title": "C"}, sort_order=30)

    deleted = repo.delete_page("page_1")

    assert deleted == 2
    assert repo.list_items("page_1", ITEM_BLOCK) == []
    assert [item.key for item in repo.list_items("page_2", ITEM_BLOCK)] == ["b3"]


@pytest.mark.unit
def test_group_member_key_is_unique_in_same_page(test_db: Session):
    repo = TransitionPageRepository(test_db)
    repo.upsert_item(
        "page_1",
        ITEM_GROUP_MEMBER,
        user_key(123),
        {"user_id": 123, "group_key": "group-a"},
    )

    with pytest.raises(IntegrityError):
        repo.create_item(
            "page_1",
            ITEM_GROUP_MEMBER,
            user_key(123),
            {"user_id": 123, "group_key": "group-b"},
        )
