# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.api.endpoints.adapter.attachments import _build_content_disposition


@pytest.mark.parametrize("disposition", ["inline", "attachment"])
@pytest.mark.parametrize(
    ("filename", "expected_filename"),
    [
        ("report.txt", 'filename="report.txt"'),
        ('a"b\\c.txt', 'filename="a\\"b\\\\c.txt"'),
        ("café.txt", "filename*=UTF-8''caf%C3%A9.txt"),
        (
            "报告/结果.txt",
            "filename*=UTF-8''%E6%8A%A5%E5%91%8A%2F%E7%BB%93%E6%9E%9C.txt",
        ),
        ("report\r\nname.txt", "filename*=UTF-8''report%0D%0Aname.txt"),
        ("report\x7fname.txt", "filename*=UTF-8''report%7Fname.txt"),
    ],
)
def test_content_disposition_encodes_filename_for_http_headers(
    disposition: str, filename: str, expected_filename: str
) -> None:
    header = _build_content_disposition(filename, disposition)

    assert header == f"{disposition}; {expected_filename}"
    assert all(32 <= ord(character) <= 126 for character in header)
