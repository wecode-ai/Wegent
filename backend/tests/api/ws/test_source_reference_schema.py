# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.ws.events import ChatDonePayload


def test_chat_done_payload_preserves_video_segment_reference() -> None:
    payload = ChatDonePayload.model_validate(
        {
            "subtask_id": 1,
            "offset": 0,
            "sources": [
                {
                    "index": 1,
                    "title": "811.video.md",
                    "kb_id": 211,
                    "source_type": "wegent_video_segment",
                    "document_id": 811,
                    "segments": [
                        {
                            "id": "segment_6_15",
                            "start_sec": 6,
                            "end_sec": 15,
                            "score": 1.0,
                            "title": "张凌赫的机场广播趣事",
                            "description": "回顾机场广播催促登机的经典事件。",
                        }
                    ],
                }
            ],
        }
    )

    source = payload.model_dump(exclude_none=True)["sources"][0]
    assert source["document_id"] == 811
    assert source["segments"] == [
        {
            "id": "segment_6_15",
            "start_sec": 6,
            "end_sec": 15,
            "score": 1.0,
            "title": "张凌赫的机场广播趣事",
            "description": "回顾机场广播催促登机的经典事件。",
        }
    ]
