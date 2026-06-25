# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.messages.attachment_preview import (
    _allocate_budget,
    apply_attachment_preview,
)

_COUNTER = TokenCounter(model_name="gpt-4o")


def test_allocate_budget_waterfills_small_first():
    # Two attachments: large 30000, small 5000; budget 30000.
    # The small one passes through fully; the large one absorbs the rest.
    alloc = _allocate_budget([30000, 5000], 30000)
    assert alloc[1] == 5000  # small kept whole
    assert alloc[0] == 25000  # large gets the leftover
    assert sum(alloc) <= 30000


def test_allocate_budget_even_when_all_large():
    alloc = _allocate_budget([30000, 30000], 30000)
    assert alloc == [15000, 15000]


def test_allocate_budget_all_fit():
    alloc = _allocate_budget([1000, 2000], 30000)
    assert alloc == [1000, 2000]


def test_allocate_budget_exhausted_does_not_floor_past_bound():
    # Budget smaller than the segment count: with the old max(1) floor this
    # summed to 5 (one token each); now it stays within budget.
    alloc = _allocate_budget([1000] * 5, 3)
    assert sum(alloc) <= 3


def _attachment_block(body: str) -> str:
    return f"<attachment>{body}</attachment>"


def test_small_attachment_body_preserved_and_marked_not_truncated():
    text = _attachment_block(
        "[Attachment: a.txt | ID: 1 | Type: text/plain]\nshort body\n\n"
    )
    messages = [{"role": "user", "content": [{"type": "text", "text": text}]}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=15000)
    new = out[0]["content"][0]["text"]
    # Body kept verbatim; header annotated with size + not-truncated; no hint.
    assert "short body" in new
    assert "tokens truncated" not in new
    assert "Truncated: no" in new
    assert "Chars:" in new and "Tokens:" in new
    assert "Preview truncated" not in new


def test_many_attachments_exhausted_budget_render_header_only():
    # Many attachments + tiny limit: header cost alone exceeds the budget, so
    # every body gets 0 allocation and renders header-only — no per-segment
    # truncation markers leaking past the bound (the bug Fix 3 addresses).
    blocks = "".join(
        f"[Attachment: f{i}.pdf | ID: {i} | Type: application/pdf]\n" + ("word " * 1000)
        for i in range(8)
    )
    text = _attachment_block(blocks)
    messages = [{"role": "user", "content": [{"type": "text", "text": text}]}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=50)
    new = out[0]["content"][0]["text"]
    # All ids stay discoverable for read_attachment.
    for i in range(8):
        assert f"ID: {i}" in new
    # No per-segment truncation markers emitted (header-only segments).
    assert "tokens truncated" not in new
    # Still marked truncated with a pointer to the full content.
    assert "Truncated: yes" in new
    assert "read_attachment" in new


def test_truncated_attachment_header_marks_truncated_yes():
    big_body = "[Attachment: a.pdf | ID: 2 | Type: application/pdf]\n" + (
        "word " * 5000
    )
    text = _attachment_block(big_body)
    messages = [{"role": "user", "content": [{"type": "text", "text": text}]}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)
    new = out[0]["content"][0]["text"]
    assert "Truncated: yes" in new
    assert "Chars:" in new and "Tokens:" in new


def test_large_attachment_body_is_truncated_with_marker():
    big_body = "[Attachment: a.txt | ID: 1 | ...]\n" + ("word " * 5000)
    text = _attachment_block(big_body)
    messages = [{"role": "user", "content": [{"type": "text", "text": text}]}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)

    new_text = out[0]["content"][0]["text"]
    assert new_text.startswith("<attachment>")
    assert new_text.endswith("</attachment>")
    assert "tokens truncated" in new_text
    # Header (with read_attachment id) survives at the head.
    assert "ID: 1" in new_text
    assert _COUNTER.count_text(new_text) < _COUNTER.count_text(text)


def test_no_newline_blob_still_truncates():
    # A single giant line (OCR/minified) must still be bounded.
    blob = "x" * 200_000
    text = _attachment_block(blob)
    messages = [{"role": "user", "content": text}]  # string content path
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)
    assert "tokens truncated" in out[0]["content"]
    assert _COUNTER.count_text(out[0]["content"]) < _COUNTER.count_text(text)


def test_non_attachment_text_untouched():
    messages = [
        {"role": "system", "content": "system prompt"},
        {"role": "user", "content": [{"type": "text", "text": "just a question"}]},
    ]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)
    assert out[0]["content"] == "system prompt"
    assert out[1]["content"][0]["text"] == "just a question"


def test_image_blocks_preserved_alongside_attachment():
    big_body = "[Attachment: a.pdf | ID: 5 | ...]\n" + ("word " * 5000)
    content = [
        {"type": "text", "text": _attachment_block(big_body)},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}},
        {"type": "text", "text": "what is in the file?"},
    ]
    messages = [{"role": "user", "content": content}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)

    blocks = out[0]["content"]
    assert blocks[1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,AAA"},
    }
    assert blocks[2]["text"] == "what is in the file?"
    assert "tokens truncated" in blocks[0]["text"]


def test_limit_zero_disables_preview():
    big_body = "[Attachment: a.txt | ID: 1]\n" + ("word " * 5000)
    text = _attachment_block(big_body)
    messages = [{"role": "user", "content": text}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=0)
    assert out[0]["content"] == text


def test_single_attachment_has_no_consolidated_id_list():
    big_body = "[Attachment: a.txt | ID: 1 | Type: t]\n" + ("word " * 5000)
    text = _attachment_block(big_body)
    messages = [{"role": "user", "content": text}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)
    assert "Attachment IDs in this message" not in out[0]["content"]


def test_multiple_attachments_preserve_all_headers_and_consolidate_ids():
    seg1 = "[Attachment: a.pdf | ID: 1 | Type: x]\n" + ("alpha " * 4000)
    seg2 = "[Attachment: b.pdf | ID: 2 | Type: y]\n" + ("beta " * 4000)
    seg3 = "[Attachment: c.pdf | ID: 3 | Type: z]\n" + ("gamma " * 4000)
    text = _attachment_block(seg1 + seg2 + seg3)
    messages = [{"role": "user", "content": text}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=600)

    new = out[0]["content"]
    # Every header survives — including the middle one (its read_attachment id).
    for marker in ("ID: 1", "ID: 2", "ID: 3"):
        assert marker in new
    # Ids consolidated up front.
    assert "Attachment IDs in this message: 1, 2, 3" in new
    # Each segment kept a head and a tail (so the body got truncated).
    assert "tokens truncated" in new
    # Shared budget: total is bounded well below the original.
    assert _COUNTER.count_text(new) < _COUNTER.count_text(text)


def test_truncated_binary_attachment_hints_read_attachment():
    header = (
        "[Attachment: report.pdf | ID: 9 | Type: application/pdf | Size: 1.0 KB | "
        "URL: /api/attachments/9/download | "
        "File Path(already in sandbox): /home/user/1:executor:attachments/2/report.pdf]"
    )
    text = _attachment_block(header + "\n" + ("word " * 5000))
    messages = [{"role": "user", "content": text}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)
    new = out[0]["content"]
    assert "read_attachment(attachment_id=9)" in new
    assert "parsed text" in new
    # Not locked to read_attachment: also offers the sandbox file as an option.
    assert "sandbox file" in new


def test_truncated_xmind_attachment_hints_read_attachment():
    # XMind is a binary (zip) doc: the sandbox file isn't text, so the hint must
    # point to read_attachment, not the sandbox path (shared MIME classification).
    header = (
        "[Attachment: mind.xmind | ID: 4 | Type: application/vnd.xmind.workbook | "
        "Size: 1.0 KB | URL: /api/attachments/4/download | "
        "File Path(already in sandbox): /home/user/1:executor:attachments/2/mind.xmind]"
    )
    text = _attachment_block(header + "\n" + ("word " * 5000))
    messages = [{"role": "user", "content": text}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)
    new = out[0]["content"]
    assert "read_attachment(attachment_id=4)" in new
    assert "parsed text" in new


def test_truncated_text_attachment_hints_sandbox_path():
    path = "/home/user/1:executor:attachments/2/notes.txt"
    header = (
        "[Attachment: notes.txt | ID: 3 | Type: text/plain | Size: 1.0 KB | "
        f"URL: /api/attachments/3/download | File Path(already in sandbox): {path}]"
    )
    text = _attachment_block(header + "\n" + ("word " * 5000))
    messages = [{"role": "user", "content": text}]
    out = apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)
    new = out[0]["content"]
    assert f"Full file in the sandbox at {path}" in new
    # Encourages targeted access (grep/search), not just reading the whole file.
    assert "grep/search" in new
    assert "read_attachment" not in new


def test_input_dicts_not_mutated():
    big_body = "[Attachment: a.txt | ID: 1]\n" + ("word " * 5000)
    text = _attachment_block(big_body)
    original = {"role": "user", "content": [{"type": "text", "text": text}]}
    messages = [original]
    apply_attachment_preview(messages, token_counter=_COUNTER, limit=200)
    # original untouched
    assert original["content"][0]["text"] == text
