# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from wecode.video.api.cards import (
    create_pending_card_block,
    update_card_block,
)


def test_card_block_moves_from_pending_to_populated():
    pending = create_pending_card_block(
        card_id="abc",
        card_type="video_director_generation",
        preview_title="生成中",
        progress_text="正在生成剧本",
    )

    populated = update_card_block(
        pending,
        card_status="populated",
        card_data={"title": "短片"},
        progress=100,
    )

    assert populated["id"] == "card-abc"
    assert populated["card_status"] == "populated"
    assert populated["card_data"] == {"title": "短片"}
    assert populated["card_preview_data"]["progress"] == 100
