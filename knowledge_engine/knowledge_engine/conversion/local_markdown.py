# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local converters for structured text formats to Markdown."""

from __future__ import annotations

import email.policy
import posixpath
import zipfile
from dataclasses import dataclass
from email.parser import BytesParser
from html import escape
from io import BytesIO
from typing import Callable, Iterable

import html2text
from bs4 import BeautifulSoup
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

from knowledge_engine.conversion.formats import decode_text_bytes, normalize_extension

LocalMarkdownConverter = Callable[[bytes], str]
_EPUB_MAX_ENTRY_UNCOMPRESSED_BYTES = 10 * 1024 * 1024
_EPUB_MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024


def convert_local_markdown(binary_data: bytes, file_extension: str) -> bytes:
    """Convert a locally supported format to UTF-8 Markdown bytes."""

    ext = normalize_extension(file_extension)
    converter = _LOCAL_MARKDOWN_CONVERTERS.get(ext)
    if converter is None:
        raise RuntimeError(f"Local Markdown conversion for '{ext}' is not supported")

    try:
        markdown = converter(binary_data)
    except Exception as exc:
        if isinstance(exc, RuntimeError) and not isinstance(exc, RecursionError):
            raise
        raise RuntimeError(f"Failed to convert .{ext} to Markdown: {exc}") from exc

    return _ensure_trailing_newline(markdown).encode("utf-8")


def _ensure_trailing_newline(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        raise RuntimeError("Converted Markdown is empty")
    return f"{stripped}\n"


def _html_to_markdown(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for node in soup(["script", "style", "noscript"]):
        node.decompose()

    converter = html2text.HTML2Text()
    converter.body_width = 0
    converter.ignore_links = False
    converter.ignore_images = False
    converter.ignore_tables = False
    return converter.handle(str(soup))


def _convert_html(binary_data: bytes) -> str:
    return _html_to_markdown(decode_text_bytes(binary_data))


def _convert_epub(binary_data: bytes) -> str:
    if not zipfile.is_zipfile(BytesIO(binary_data)):
        raise RuntimeError("Invalid EPUB file: expected a ZIP package")

    with zipfile.ZipFile(BytesIO(binary_data)) as archive:
        budget = _ZipReadBudget(_EPUB_MAX_TOTAL_UNCOMPRESSED_BYTES)
        rootfile = _find_epub_rootfile(archive, budget)
        if not rootfile:
            raise RuntimeError("Invalid EPUB file: missing OPF rootfile")

        try:
            opf_root = ElementTree.fromstring(
                _read_epub_entry(
                    archive,
                    rootfile,
                    budget,
                    max_entry_bytes=_EPUB_MAX_ENTRY_UNCOMPRESSED_BYTES,
                )
            )
        except (ElementTree.ParseError, DefusedXmlException) as exc:
            raise RuntimeError(
                f"Invalid EPUB file: invalid OPF rootfile: {exc}"
            ) from exc

        manifest = _read_epub_manifest(opf_root)
        spine_paths = _read_epub_spine_paths(opf_root, manifest, rootfile)
        if not spine_paths:
            spine_paths = _read_epub_html_paths(manifest, rootfile)

        sections: list[str] = []
        for path in spine_paths:
            try:
                html = decode_text_bytes(
                    _read_epub_entry(
                        archive,
                        path,
                        budget,
                        max_entry_bytes=_EPUB_MAX_ENTRY_UNCOMPRESSED_BYTES,
                    )
                )
            except KeyError:
                continue
            markdown = _html_to_markdown(html).strip()
            if markdown:
                sections.append(markdown)

    if not sections:
        raise RuntimeError("Invalid EPUB file: no readable document sections found")
    return "\n\n".join(sections)


@dataclass
class _ZipReadBudget:
    total_limit: int
    consumed: int = 0


def _read_epub_entry(
    archive: zipfile.ZipFile,
    path: str,
    budget: _ZipReadBudget,
    *,
    max_entry_bytes: int,
) -> bytes:
    info = archive.getinfo(path)
    if info.file_size > max_entry_bytes:
        raise RuntimeError(
            f"Invalid EPUB file: entry '{path}' exceeds "
            f"{max_entry_bytes} uncompressed bytes"
        )
    if budget.consumed + info.file_size > budget.total_limit:
        raise RuntimeError(
            "Invalid EPUB file: total uncompressed content exceeds "
            f"{budget.total_limit} bytes"
        )

    data = archive.read(info)
    actual_size = len(data)
    if actual_size > max_entry_bytes:
        raise RuntimeError(
            f"Invalid EPUB file: entry '{path}' exceeds "
            f"{max_entry_bytes} uncompressed bytes"
        )
    if budget.consumed + actual_size > budget.total_limit:
        raise RuntimeError(
            "Invalid EPUB file: total uncompressed content exceeds "
            f"{budget.total_limit} bytes"
        )
    budget.consumed += max(info.file_size, actual_size)
    return data


def _find_epub_rootfile(
    archive: zipfile.ZipFile,
    budget: _ZipReadBudget,
) -> str | None:
    try:
        container = ElementTree.fromstring(
            _read_epub_entry(
                archive,
                "META-INF/container.xml",
                budget,
                max_entry_bytes=_EPUB_MAX_ENTRY_UNCOMPRESSED_BYTES,
            )
        )
    except (KeyError, ElementTree.ParseError, DefusedXmlException):
        return None

    for element in container.iter():
        if _tag_name(element) == "rootfile":
            full_path = element.attrib.get("full-path", "").strip()
            if full_path:
                return full_path
    return None


def _read_epub_manifest(root: ElementTree.Element) -> dict[str, dict[str, str]]:
    manifest: dict[str, dict[str, str]] = {}
    for element in root.iter():
        if _tag_name(element) != "item":
            continue
        item_id = element.attrib.get("id")
        href = element.attrib.get("href")
        if not item_id or not href:
            continue
        manifest[item_id] = {
            "href": href,
            "media_type": element.attrib.get("media-type", ""),
        }
    return manifest


def _read_epub_spine_paths(
    root: ElementTree.Element,
    manifest: dict[str, dict[str, str]],
    rootfile: str,
) -> list[str]:
    paths: list[str] = []
    for element in root.iter():
        if _tag_name(element) != "itemref":
            continue
        item = manifest.get(element.attrib.get("idref", ""))
        if not item:
            continue
        paths.append(_resolve_epub_path(rootfile, item["href"]))
    return paths


def _read_epub_html_paths(
    manifest: dict[str, dict[str, str]],
    rootfile: str,
) -> list[str]:
    html_media_types = {
        "application/xhtml+xml",
        "text/html",
    }
    return [
        _resolve_epub_path(rootfile, item["href"])
        for item in manifest.values()
        if item.get("media_type") in html_media_types
    ]


def _resolve_epub_path(rootfile: str, href: str) -> str:
    base = posixpath.dirname(rootfile)
    return posixpath.normpath(posixpath.join(base, href))


def _convert_eml(binary_data: bytes) -> str:
    message = BytesParser(policy=email.policy.default).parsebytes(binary_data)
    lines: list[str] = []

    subject = message.get("subject")
    if subject:
        lines.extend([f"# {_escape_markdown_value(subject)}", ""])

    for header in ("from", "to", "cc", "date"):
        value = message.get(header)
        if value:
            lines.append(f"**{header.title()}:** {_escape_markdown_value(value)}")
    if lines and lines[-1] != "":
        lines.append("")

    plain_body = _first_message_part(message, "text/plain")
    html_body = _first_message_part(message, "text/html")
    if plain_body:
        lines.append(plain_body.strip())
    elif html_body:
        lines.append(_html_to_markdown(html_body).strip())

    attachments = [
        part.get_filename()
        for part in message.walk()
        if part.get_content_disposition() == "attachment" and part.get_filename()
    ]
    if attachments:
        lines.extend(["", "## Attachments", ""])
        lines.extend(f"- {escape(name)}" for name in attachments)

    return "\n".join(part for part in lines if part is not None)


def _escape_markdown_value(value: object) -> str:
    return escape(str(value))


def _first_message_part(message, content_type: str) -> str:
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.get_content_type() != content_type:
            continue
        if part.get_content_disposition() == "attachment":
            continue
        content = part.get_content()
        if isinstance(content, bytes):
            return decode_text_bytes(content)
        return str(content)
    return ""


def _convert_xml(binary_data: bytes) -> str:
    xml_text = decode_text_bytes(binary_data)
    try:
        root = ElementTree.fromstring(xml_text)
    except (ElementTree.ParseError, DefusedXmlException) as exc:
        raise RuntimeError(f"Invalid XML file: {exc}") from exc

    lines = ["# XML Document", ""]
    lines.extend(_xml_element_lines(root))
    if len(lines) <= 2:
        raise RuntimeError("XML file has no readable text content")
    return "\n".join(lines)


def _xml_element_lines(element: ElementTree.Element, depth: int = 0) -> Iterable[str]:
    tag = _tag_name(element)
    text = " ".join((element.text or "").split())
    children = list(element)
    indent = "  " * min(depth, 4)

    if text:
        yield f"{indent}- **{tag}:** {text}"
    elif children:
        yield f"{indent}- **{tag}**"

    for child in children:
        yield from _xml_element_lines(child, depth + 1)


def _tag_name(element: ElementTree.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


_LOCAL_MARKDOWN_CONVERTERS: dict[str, LocalMarkdownConverter] = {
    "epub": _convert_epub,
    "eml": _convert_eml,
    "html": _convert_html,
    "htm": _convert_html,
    "xml": _convert_xml,
}
