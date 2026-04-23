from wecode.models.transition_page import TransitionPageItem


def test_transition_page_item_defaults():
    item = TransitionPageItem(
        id=123456789,
        page_id="page_abc",
        type="block",
        key="block-notice",
        data_json={"title": "Notice"},
        sort_order=0,
    )

    assert item.id == 123456789
    assert item.page_id == "page_abc"
    assert item.type == "block"
    assert item.key == "block-notice"
    assert item.global_key == ""
    assert item.parent_key == ""
    assert item.sort_order == 0
    assert item.data_json == {"title": "Notice"}


def test_transition_page_item_table_metadata():
    table = TransitionPageItem.__table__

    assert table.name == "transition_page_items"
    assert {
        "page_id",
        "type",
        "key",
        "global_key",
        "data_json",
        "sort_order",
    }.issubset(table.columns.keys())

    index_names = {index.name for index in table.indexes}

    assert "uniq_transition_page_item" in index_names
    assert "uniq_transition_page_items_global_key" in index_names
    assert "idx_transition_page_items_type_key" in index_names
    assert "idx_transition_page_items_page_type" in index_names
    assert "idx_transition_page_items_page_type_order" in index_names
