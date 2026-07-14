# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge-base file format capabilities.

This module is the backend-side source of truth for formats that can enter the
knowledge-base ingestion pipeline. It intentionally stays lightweight: adding a
format should mean adding one registry entry and, only when needed, a converter.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from enum import Enum
from typing import Iterable, Optional

import chardet


class KnowledgeFormatPipeline(str, Enum):
    """How a knowledge-base file is prepared for indexing."""

    DIRECT = "direct"
    MINERU = "mineru"
    LOCAL_MARKDOWN = "local_markdown"
    MULTIMODAL = "multimodal"


class KnowledgeFormatSupportLevel(str, Enum):
    """Current support status exposed to server-side callers."""

    STABLE = "stable"
    CONDITIONAL = "conditional"
    FUTURE = "future"


@dataclass(frozen=True)
class KnowledgeFileFormat:
    """A single knowledge-base file format capability."""

    extension: str
    mime_types: tuple[str, ...]
    category: str
    pipeline: KnowledgeFormatPipeline
    support_level: KnowledgeFormatSupportLevel = KnowledgeFormatSupportLevel.STABLE
    enabled: bool = True
    notes: str = ""

    @property
    def dotted_extension(self) -> str:
        return f".{self.extension}"


def _fmt(
    extension: str,
    mime_types: Iterable[str],
    category: str,
    pipeline: KnowledgeFormatPipeline,
    support_level: KnowledgeFormatSupportLevel = KnowledgeFormatSupportLevel.STABLE,
    *,
    enabled: bool = True,
    notes: str = "",
) -> KnowledgeFileFormat:
    return KnowledgeFileFormat(
        extension=normalize_extension(extension),
        mime_types=tuple(mime_types),
        category=category,
        pipeline=pipeline,
        support_level=support_level,
        enabled=enabled,
        notes=notes,
    )


def normalize_extension(file_extension: Optional[str]) -> str:
    """Normalize an extension to lower-case, dot-less form."""

    return (file_extension or "").strip().lstrip(".").lower()


KNOWLEDGE_FILE_FORMATS: tuple[KnowledgeFileFormat, ...] = (
    # Rich documents converted to Markdown before indexing.
    _fmt("pdf", ("application/pdf",), "document", KnowledgeFormatPipeline.MINERU),
    _fmt(
        "docx",
        ("application/vnd.openxmlformats-officedocument.wordprocessingml.document",),
        "document",
        KnowledgeFormatPipeline.MINERU,
    ),
    _fmt(
        "doc",
        ("application/msword",),
        "document",
        KnowledgeFormatPipeline.MINERU,
        KnowledgeFormatSupportLevel.CONDITIONAL,
        notes="Legacy Word documents depend on the configured conversion backend.",
    ),
    _fmt(
        "pptx",
        ("application/vnd.openxmlformats-officedocument.presentationml.presentation",),
        "presentation",
        KnowledgeFormatPipeline.MINERU,
    ),
    _fmt(
        "ppt",
        ("application/vnd.ms-powerpoint",),
        "presentation",
        KnowledgeFormatPipeline.MINERU,
        KnowledgeFormatSupportLevel.CONDITIONAL,
        notes="Legacy PowerPoint documents depend on the configured conversion backend.",
    ),
    _fmt(
        "xlsx",
        ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",),
        "spreadsheet",
        KnowledgeFormatPipeline.MINERU,
    ),
    _fmt(
        "xls",
        ("application/vnd.ms-excel",),
        "spreadsheet",
        KnowledgeFormatPipeline.MINERU,
        KnowledgeFormatSupportLevel.CONDITIONAL,
        notes="Legacy Excel documents depend on the configured conversion backend.",
    ),
    # Local Markdown normalization in the converter worker.
    _fmt(
        "epub",
        ("application/epub+zip",),
        "document",
        KnowledgeFormatPipeline.LOCAL_MARKDOWN,
    ),
    _fmt(
        "eml",
        ("message/rfc822", "text/plain"),
        "document",
        KnowledgeFormatPipeline.LOCAL_MARKDOWN,
        notes="RFC822 email messages only; Outlook .msg is not supported.",
    ),
    _fmt("html", ("text/html",), "web", KnowledgeFormatPipeline.LOCAL_MARKDOWN),
    _fmt("htm", ("text/html",), "web", KnowledgeFormatPipeline.LOCAL_MARKDOWN),
    _fmt(
        "xml",
        ("text/xml", "application/xml"),
        "config",
        KnowledgeFormatPipeline.LOCAL_MARKDOWN,
        KnowledgeFormatSupportLevel.CONDITIONAL,
        notes="Structured XML is supported; binary or object-only XML containers are not.",
    ),
    # Direct text/code/config indexing.
    _fmt("txt", ("text/plain",), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt("md", ("text/markdown", "text/plain"), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "markdown",
        ("text/markdown", "text/plain"),
        "text",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt("adoc", ("text/plain",), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt("asciidoc", ("text/plain",), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt("license", ("text/plain",), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt("log", ("text/plain",), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt("readme", ("text/plain",), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt("rst", ("text/x-rst", "text/plain"), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "srt",
        ("application/x-subrip", "text/plain"),
        "text",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt("textile", ("text/plain",), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt("wiki", ("text/plain",), "text", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "csv", ("text/csv", "text/plain"), "spreadsheet", KnowledgeFormatPipeline.DIRECT
    ),
    _fmt(
        "tsv",
        ("text/tab-separated-values", "text/plain"),
        "spreadsheet",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt("py", ("text/x-python", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("asm", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("bat", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("c", ("text/x-csrc", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("cc", ("text/x-c++src", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "cpp", ("text/x-c++src", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT
    ),
    _fmt("css", ("text/css", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("dart", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("go", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("gradle", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("groovy", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("h", ("text/x-csrc", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "java",
        ("text/x-java-source", "text/plain"),
        "code",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt(
        "js",
        ("application/javascript", "text/plain"),
        "code",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt(
        "jsx",
        ("text/jsx", "application/javascript", "text/plain"),
        "code",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt("kt", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("kts", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("kotlin", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("less", ("text/css", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("lua", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "mjs",
        ("application/javascript", "text/plain"),
        "code",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt("php", ("text/x-php", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("pl", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("ps1", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("rb", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("rs", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("rust", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("sass", ("text/css", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("scala", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("scss", ("text/css", "text/plain"), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "sh",
        ("text/x-shellscript", "text/plain"),
        "code",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt("sql", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("styl", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("swift", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "ts",
        ("application/typescript", "text/plain"),
        "code",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt(
        "tsx",
        ("text/tsx", "application/typescript", "text/plain"),
        "code",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt("vue", ("text/plain",), "code", KnowledgeFormatPipeline.DIRECT),
    _fmt("yaml", ("text/yaml", "text/plain"), "config", KnowledgeFormatPipeline.DIRECT),
    _fmt("yml", ("text/yaml", "text/plain"), "config", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "json",
        ("application/json", "text/plain"),
        "config",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt("conf", ("text/plain",), "config", KnowledgeFormatPipeline.DIRECT),
    _fmt("config", ("text/plain",), "config", KnowledgeFormatPipeline.DIRECT),
    _fmt("env", ("text/plain",), "config", KnowledgeFormatPipeline.DIRECT),
    _fmt("ini", ("text/plain",), "config", KnowledgeFormatPipeline.DIRECT),
    _fmt("properties", ("text/plain",), "config", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "svg",
        ("image/svg+xml", "text/plain"),
        "config",
        KnowledgeFormatPipeline.DIRECT,
    ),
    _fmt("toml", ("text/plain",), "config", KnowledgeFormatPipeline.DIRECT),
    _fmt(
        "lock",
        ("text/plain",),
        "config",
        KnowledgeFormatPipeline.DIRECT,
        KnowledgeFormatSupportLevel.CONDITIONAL,
        notes="Only plain-text lock files are supported.",
    ),
    # Existing Wegent special parser.
    _fmt(
        "xmind",
        ("application/vnd.xmind.workbook",),
        "mindmap",
        KnowledgeFormatPipeline.DIRECT,
    ),
    # Multimodal formats; KB-level model configuration gates actual analysis.
    _fmt("jpg", ("image/jpeg",), "image", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("jpeg", ("image/jpeg",), "image", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("png", ("image/png",), "image", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("gif", ("image/gif",), "image", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("webp", ("image/webp",), "image", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("bmp", ("image/bmp",), "image", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("mp4", ("video/mp4",), "video", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("avi", ("video/x-msvideo",), "video", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("mov", ("video/quicktime",), "video", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("mkv", ("video/x-matroska",), "video", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("webm", ("video/webm",), "video", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("flv", ("video/x-flv",), "video", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("wmv", ("video/x-ms-wmv",), "video", KnowledgeFormatPipeline.MULTIMODAL),
    _fmt("m4v", ("video/x-m4v",), "video", KnowledgeFormatPipeline.MULTIMODAL),
    # iWork is intentionally visible in the registry but disabled by default.
    _fmt(
        "key",
        ("application/x-iwork-keynote-sffkey",),
        "iwork",
        KnowledgeFormatPipeline.LOCAL_MARKDOWN,
        KnowledgeFormatSupportLevel.FUTURE,
        enabled=False,
        notes="Requires a dedicated iWork conversion provider.",
    ),
    _fmt(
        "numbers",
        ("application/x-iwork-numbers-sffnumbers",),
        "iwork",
        KnowledgeFormatPipeline.LOCAL_MARKDOWN,
        KnowledgeFormatSupportLevel.FUTURE,
        enabled=False,
        notes="Requires a dedicated iWork conversion provider.",
    ),
    _fmt(
        "pages",
        ("application/x-iwork-pages-sffpages",),
        "iwork",
        KnowledgeFormatPipeline.LOCAL_MARKDOWN,
        KnowledgeFormatSupportLevel.FUTURE,
        enabled=False,
        notes="Requires a dedicated iWork conversion provider.",
    ),
)

_FORMAT_BY_EXTENSION = {fmt.extension: fmt for fmt in KNOWLEDGE_FILE_FORMATS}
_TEXT_LIKE_CATEGORIES = frozenset({"text", "code", "config"})
_CONVERSION_PIPELINES = frozenset(
    {KnowledgeFormatPipeline.MINERU, KnowledgeFormatPipeline.LOCAL_MARKDOWN}
)


def get_knowledge_format(
    file_extension: Optional[str],
    *,
    include_disabled: bool = False,
) -> KnowledgeFileFormat | None:
    """Return the registered format for an extension."""

    fmt = _FORMAT_BY_EXTENSION.get(normalize_extension(file_extension))
    if fmt is None:
        return None
    if not fmt.enabled and not include_disabled:
        return None
    return fmt


def list_knowledge_formats(
    *,
    include_disabled: bool = False,
) -> tuple[KnowledgeFileFormat, ...]:
    """List known knowledge-base formats."""

    if include_disabled:
        return KNOWLEDGE_FILE_FORMATS
    return tuple(fmt for fmt in KNOWLEDGE_FILE_FORMATS if fmt.enabled)


def is_supported_knowledge_format(file_extension: Optional[str]) -> bool:
    """Return True when the format is currently accepted for KB upload."""

    return get_knowledge_format(file_extension) is not None


def supported_knowledge_extensions() -> tuple[str, ...]:
    """Return sorted dotted extensions currently accepted for KB upload."""

    return tuple(sorted(fmt.dotted_extension for fmt in list_knowledge_formats()))


def get_knowledge_pipeline(
    file_extension: Optional[str],
) -> KnowledgeFormatPipeline | None:
    """Return the pipeline used by a currently enabled knowledge format."""

    fmt = get_knowledge_format(file_extension)
    if fmt is None:
        return None
    return fmt.pipeline


def conversion_required(file_extension: Optional[str]) -> bool:
    """Return True if the format must be converted before direct indexing."""

    pipeline = get_knowledge_pipeline(file_extension)
    return pipeline in _CONVERSION_PIPELINES


def decode_text_bytes(binary_data: bytes) -> str:
    """Decode text-like uploads with a conservative binary guard."""

    if not binary_data:
        return ""
    if b"\x00" in binary_data[:4096]:
        raise ValueError("File content appears to be binary, not text")

    for encoding in ("utf-8-sig",):
        try:
            return binary_data.decode(encoding)
        except UnicodeDecodeError:
            continue

    detected = chardet.detect(binary_data[: min(len(binary_data), 1024 * 1024)])
    encoding = detected.get("encoding")
    confidence = float(detected.get("confidence") or 0)
    if encoding and confidence >= 0.5:
        try:
            return binary_data.decode(encoding)
        except UnicodeDecodeError:
            pass

    raise ValueError("Unable to decode file content as text")


def validate_knowledge_file(binary_data: bytes, file_extension: Optional[str]) -> None:
    """Validate format-specific invariants before storing a KB raw attachment."""

    fmt = get_knowledge_format(file_extension)
    ext = normalize_extension(file_extension)
    if fmt is None:
        supported = ", ".join(supported_knowledge_extensions())
        raise ValueError(
            f"Unsupported knowledge file type: .{ext or 'unknown'}. "
            f"Supported types: {supported}"
        )

    if (
        fmt.pipeline == KnowledgeFormatPipeline.DIRECT
        and fmt.category in _TEXT_LIKE_CATEGORIES
    ):
        decode_text_bytes(binary_data)
        return

    if ext in {"csv", "tsv"}:
        decode_text_bytes(binary_data)
        return

    if ext in {"html", "htm", "xml", "eml"}:
        decode_text_bytes(binary_data)
        return

    if (
        ext == "epub"
        and binary_data
        and not zipfile.is_zipfile(io.BytesIO(binary_data))
    ):
        raise ValueError("Invalid EPUB file: expected a ZIP-based EPUB package")
