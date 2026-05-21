# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services.knowledge.folder_policy import (
    assert_document_can_be_placed_in_folder,
    get_folder_depth,
    get_subtree_max_relative_depth,
)


def test_get_folder_depth_rejects_parent_cycle():
    folder_map = {
        1: SimpleNamespace(id=1, parent_id=2),
        2: SimpleNamespace(id=2, parent_id=1),
    }

    with pytest.raises(ValueError, match="Folder 1 has a parent cycle"):
        get_folder_depth(MagicMock(), kind_id=1, folder_id=1, folder_map=folder_map)


def test_get_subtree_max_relative_depth_rejects_cycle():
    folder_map = {
        1: SimpleNamespace(id=1, parent_id=2),
        2: SimpleNamespace(id=2, parent_id=1),
    }

    with pytest.raises(ValueError, match="Folder 1 has a parent cycle"):
        get_subtree_max_relative_depth(folder_map, root_folder_id=1)


def test_assert_document_can_be_placed_in_folder_allows_root_sentinel():
    db = MagicMock()

    result = assert_document_can_be_placed_in_folder(db, kind_id=1, folder_id=0)

    assert result is None
    db.query.assert_not_called()


def test_assert_document_can_be_placed_in_folder_rejects_negative_folder_id():
    db = MagicMock()

    result = assert_document_can_be_placed_in_folder(db, kind_id=1, folder_id=-1)

    assert result is None
    db.query.assert_not_called()
