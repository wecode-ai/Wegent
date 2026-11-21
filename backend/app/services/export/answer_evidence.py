"""Project cite markers for the current reader of a conversation export."""

import re
from collections.abc import Callable, Iterator

from shared.utils.evidence_markers import PROTECTED_MARKDOWN

_PROTECTED = re.compile(PROTECTED_MARKDOWN.pattern + r"|(?m:^(?: {4}|\t)[^\n]*)")
_MARKER = re.compile(
    r"(\\*)\[\\?\[(?:citation\\?:([0-9]+)|evidence\\?:[^\]\n]+?|"
    r"evidence-unavailable)\\?\]\\?\]"
)


def _prose_spans(content: str) -> Iterator[tuple[int, int]]:
    start = 0
    for match in _PROTECTED.finditer(content):
        yield start, match.start()
        start = match.end()
    yield start, len(content)


def _records(value: object) -> Iterator[dict]:
    if isinstance(value, list):
        yield from (item for item in value if isinstance(item, dict))


def filter_answer_evidence(
    content: str, result: object, get_access: Callable[[int], str]
) -> str:
    """Keep only the decoration visible to the export viewer."""
    if not isinstance(result, dict) or not _MARKER.search(content):
        return content
    spans = list(_prose_spans(content))
    marker_ids = {
        match[2]
        for start, end in spans
        for match in _MARKER.finditer(content, start, end)
        if match[2]
    }
    # Result metadata identifies decoration only. Every access fact comes from
    # the current authenticated viewer's source policy.
    citation_sources = {
        item["citation_id"]: item["knowledge_base_id"]
        for item in _records(result.get("answer_citations"))
        if isinstance(item.get("citation_id"), str)
        and item["citation_id"] in marker_ids
        and type(item.get("knowledge_base_id")) is int
    }
    sources = list(_records(result.get("sources")))
    summary = result.get("retrieval_summary")
    statuses = (
        _records(summary.get("source_statuses")) if isinstance(summary, dict) else ()
    )
    source_ids = set(citation_sources.values())
    has_unscoped_sources = False
    for source in sources:
        kb_id = source.get("kb_id")
        if type(kb_id) is int and kb_id > 0:
            source_ids.add(kb_id)
        else:
            has_unscoped_sources = True
    for status in statuses:
        if status.get("status") != "hit":
            continue
        if status.get("provider") != "internal":
            has_unscoped_sources = True
            continue
        source_id = status.get("source_id")
        if isinstance(source_id, str) and re.fullmatch(r"[1-9][0-9]{0,18}", source_id):
            source_ids.add(int(source_id))
    access = {kb_id: get_access(kb_id) for kb_id in source_ids}
    visit_only = (
        bool(access)
        and not has_unscoped_sources
        and all(value == "visit-only" for value in access.values())
    )

    def replace(match: re.Match[str]) -> str:
        kb_id = citation_sources.get(match[2])
        if visit_only or (
            kb_id is not None and access[kb_id] in ("visit-only", "denied")
        ):
            slashes = match[1]
            return slashes[: len(slashes) - len(slashes) % 2]
        return match[0]

    parts = []
    cursor = 0
    for start, end in spans:
        parts.extend((content[cursor:start], _MARKER.sub(replace, content[start:end])))
        cursor = end
    return "".join(parts)
