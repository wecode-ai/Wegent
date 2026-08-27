# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.models.blocks import CardBlock, block_from_dict, create_card_block


def test_create_card_block_uses_the_public_card_contract() -> None:
    block = create_card_block(
        card_id="card-1",
        card_type="video_director_generation",
        card_status="pending",
        card_preview_data={"progress": 10},
    )

    assert block == {
        "id": "card-1",
        "type": "card",
        "status": "pending",
        "timestamp": block["timestamp"],
        "card_id": "card-1",
        "card_type": "video_director_generation",
        "card_status": "pending",
        "card_data": {},
        "card_preview_data": {"progress": 10},
        "card_error": None,
    }


def test_block_from_dict_preserves_card_blocks() -> None:
    parsed = block_from_dict(
        {
            "id": "card-1",
            "type": "card",
            "status": "done",
            "timestamp": 1,
            "card_id": "card-1",
            "card_type": "video_director_generation",
            "card_status": "populated",
            "card_data": {"title": "成片"},
            "card_preview_data": {},
            "card_error": None,
        }
    )

    assert isinstance(parsed, CardBlock)
    assert parsed.card_data == {"title": "成片"}
