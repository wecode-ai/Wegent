# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.auth.task_token import create_task_token, verify_task_token


def test_task_token_round_trips_im_context():
    token = create_task_token(
        task_id=1,
        subtask_id=2,
        user_id=3,
        user_name="alice",
        im_session_key="session-1",
        im_channel_id=7,
    )

    info = verify_task_token(token)

    assert info is not None
    assert info.im_session_key == "session-1"
    assert info.im_channel_id == 7
