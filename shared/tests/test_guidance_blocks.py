from shared.models.blocks import (
    BlockStatus,
    BlockType,
    GuidanceBlock,
    block_from_dict,
    create_guidance_block,
)


def test_guidance_block_round_trip() -> None:
    block = GuidanceBlock(
        id="guidance-g1",
        guidance_id="g1",
        content="Use the short answer.",
        applied_at="2026-05-14T10:00:00Z",
        timestamp=123,
    )

    data = block.to_dict()
    parsed = block_from_dict(data)

    assert data == {
        "id": "guidance-g1",
        "type": BlockType.GUIDANCE.value,
        "guidance_id": "g1",
        "content": "Use the short answer.",
        "status": BlockStatus.DONE.value,
        "timestamp": 123,
        "applied_at": "2026-05-14T10:00:00Z",
    }
    assert isinstance(parsed, GuidanceBlock)
    assert parsed.guidance_id == "g1"


def test_create_guidance_block_uses_done_status() -> None:
    block = create_guidance_block(
        guidance_id="g2",
        content="Prefer examples.",
        block_id="custom-block",
        loop_index=2,
        timestamp=456,
    )

    assert block == {
        "id": "custom-block",
        "type": "guidance",
        "guidance_id": "g2",
        "content": "Prefer examples.",
        "status": "done",
        "timestamp": 456,
        "loop_index": 2,
    }
