# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import html
import io
import json
import zipfile
from html.parser import HTMLParser
from typing import Any, Iterable
from xml.etree import ElementTree


class XMindParseError(ValueError):
    """Raised when an XMind archive cannot be converted to text."""


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        cleaned = _clean_text(data)
        if cleaned:
            self._parts.append(cleaned)

    def text(self) -> str:
        return " ".join(self._parts)


def parse_xmind_to_markdown(binary_data: bytes) -> str:
    """Convert an XMind archive into markdown-like text."""
    try:
        with zipfile.ZipFile(io.BytesIO(binary_data)) as archive:
            names = set(archive.namelist())
            if "content.json" in names:
                markdown = _parse_content_json(archive.read("content.json"))
            elif "content.xml" in names:
                markdown = _parse_content_xml(archive.read("content.xml"))
            else:
                raise XMindParseError(
                    "XMind archive does not contain content.json or content.xml"
                )
    except zipfile.BadZipFile as exc:
        raise XMindParseError("Invalid XMind archive") from exc
    except (json.JSONDecodeError, ElementTree.ParseError) as exc:
        raise XMindParseError(f"Invalid XMind content: {exc}") from exc

    markdown = markdown.strip()
    if not markdown:
        raise XMindParseError("XMind archive contains no readable topics")
    return markdown


def _parse_content_json(raw_content: bytes) -> str:
    payload = json.loads(raw_content.decode("utf-8-sig"))
    sheets = payload if isinstance(payload, list) else [payload]
    sections: list[str] = []

    for index, sheet in enumerate(sheets, start=1):
        if not isinstance(sheet, dict):
            continue
        lines: list[str] = []
        sheet_title = _clean_text(sheet.get("title")) or f"Sheet {index}"
        lines.append(f"# {sheet_title}")

        root_topic = sheet.get("rootTopic")
        if isinstance(root_topic, dict):
            lines.extend(_render_json_topic(root_topic, depth=0))

        section = "\n".join(line for line in lines if line).strip()
        if section:
            sections.append(section)

    return "\n\n".join(sections)


def _render_json_topic(topic: dict[str, Any], *, depth: int) -> list[str]:
    lines: list[str] = []
    title = _clean_text(topic.get("title")) or "Untitled topic"
    indent = "  " * depth
    lines.append(f"{indent}- {title}")

    note = _extract_json_note(topic.get("notes"))
    if note:
        lines.extend(_render_multiline_detail("Note", note, depth=depth + 1))

    labels = _extract_json_labels(topic.get("labels"))
    if labels:
        lines.append(f"{'  ' * (depth + 1)}Labels: {', '.join(labels)}")

    for child in _iter_json_child_topics(topic.get("children")):
        lines.extend(_render_json_topic(child, depth=depth + 1))

    return lines


def _iter_json_child_topics(children: Any) -> Iterable[dict[str, Any]]:
    if not isinstance(children, dict):
        return

    for group in children.values():
        if isinstance(group, list):
            for child in group:
                if isinstance(child, dict):
                    yield child
        elif isinstance(group, dict):
            for value in group.values():
                if isinstance(value, list):
                    for child in value:
                        if isinstance(child, dict):
                            yield child
                elif isinstance(value, dict):
                    yield value


def _extract_json_note(notes: Any) -> str:
    if not isinstance(notes, dict):
        return ""

    plain = notes.get("plain")
    if isinstance(plain, dict):
        note = _clean_text(plain.get("content"))
        if note:
            return note
    elif isinstance(plain, str):
        note = _clean_text(plain)
        if note:
            return note

    html_note = notes.get("html")
    if isinstance(html_note, dict):
        return _html_to_text(str(html_note.get("content") or ""))
    if isinstance(html_note, str):
        return _html_to_text(html_note)
    return ""


def _extract_json_labels(labels: Any) -> list[str]:
    if not isinstance(labels, list):
        return []
    return [label for label in (_clean_text(item) for item in labels) if label]


def _parse_content_xml(raw_content: bytes) -> str:
    root = ElementTree.fromstring(raw_content)
    sheets = [element for element in root.iter() if _local_name(element.tag) == "sheet"]
    sections: list[str] = []

    for index, sheet in enumerate(sheets, start=1):
        lines: list[str] = []
        sheet_title = _child_text(sheet, "title") or f"Sheet {index}"
        lines.append(f"# {sheet_title}")

        topic = _direct_child(sheet, "topic")
        if topic is not None:
            lines.extend(_render_xml_topic(topic, depth=0))

        section = "\n".join(line for line in lines if line).strip()
        if section:
            sections.append(section)

    return "\n\n".join(sections)


def _render_xml_topic(topic: ElementTree.Element, *, depth: int) -> list[str]:
    lines: list[str] = []
    title = _child_text(topic, "title") or "Untitled topic"
    indent = "  " * depth
    lines.append(f"{indent}- {title}")

    note = _extract_xml_note(topic)
    if note:
        lines.extend(_render_multiline_detail("Note", note, depth=depth + 1))

    for child in _iter_xml_child_topics(topic):
        lines.extend(_render_xml_topic(child, depth=depth + 1))

    return lines


def _iter_xml_child_topics(topic: ElementTree.Element) -> Iterable[ElementTree.Element]:
    children = _direct_child(topic, "children")
    if children is None:
        return

    for topics in children:
        if _local_name(topics.tag) != "topics":
            continue
        for child in topics:
            if _local_name(child.tag) == "topic":
                yield child


def _extract_xml_note(topic: ElementTree.Element) -> str:
    notes = _direct_child(topic, "notes")
    if notes is None:
        return ""

    plain = _direct_child(notes, "plain")
    if plain is not None:
        note = _clean_text("".join(plain.itertext()))
        if note:
            return note

    html_note = _direct_child(notes, "html")
    if html_note is not None:
        return _html_to_text("".join(html_note.itertext()))
    return ""


def _render_multiline_detail(label: str, text: str, *, depth: int) -> list[str]:
    indent = "  " * depth
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return []
    first, *rest = lines
    rendered = [f"{indent}{label}: {first}"]
    rendered.extend(f"{indent}{line}" for line in rest)
    return rendered


def _direct_child(
    element: ElementTree.Element, name: str
) -> ElementTree.Element | None:
    for child in element:
        if _local_name(child.tag) == name:
            return child
    return None


def _child_text(element: ElementTree.Element, name: str) -> str:
    child = _direct_child(element, name)
    if child is None:
        return ""
    return _clean_text("".join(child.itertext()))


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _html_to_text(raw_html: str) -> str:
    parser = _HTMLTextExtractor()
    parser.feed(html.unescape(raw_html))
    return _clean_text(parser.text())


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\r", "\n").split())
