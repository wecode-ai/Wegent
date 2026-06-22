# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest


@pytest.fixture(autouse=True)
def use_fake_im_session_cache(fake_im_session_cache):
    return fake_im_session_cache
