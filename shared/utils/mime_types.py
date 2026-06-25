# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Canonical text/binary classification for attachment MIME types.

Single source of truth shared by the backend document parser (which decides how
to parse/extract a file) and the chat_shell attachment preview (which decides
whether the sandbox file is directly readable as text, or the parsed text must
be fetched via ``read_attachment``). Keeping one definition here prevents the
two sides from drifting as new file types are added.
"""

from __future__ import annotations

# Text-based ``application/*`` MIME types. The ``text/*`` family is matched by
# prefix in ``is_text_readable_mime`` (so it need not be enumerated), but the
# text/* entries are kept here too so the set itself is a complete answer for
# callers that test membership directly.
TEXT_READABLE_MIME_TYPES: frozenset[str] = frozenset(
    {
        # text/* family
        "text/plain",
        "text/html",
        "text/css",
        "text/javascript",
        "text/xml",
        "text/csv",
        "text/markdown",
        "text/x-python",
        "text/x-java",
        "text/x-c",
        "text/x-c++",
        "text/x-ruby",
        "text/x-perl",
        "text/x-php",
        "text/x-shellscript",
        "text/x-script.python",
        "text/x-go",
        "text/x-rust",
        "text/x-swift",
        "text/x-kotlin",
        "text/x-scala",
        "text/x-typescript",
        "text/x-coffeescript",
        "text/x-lua",
        "text/x-r",
        "text/x-matlab",
        "text/x-sql",
        "text/x-yaml",
        "text/x-toml",
        "text/x-ini",
        "text/x-properties",
        "text/x-diff",
        "text/x-patch",
        "text/x-log",
        "text/x-makefile",
        "text/x-cmake",
        "text/x-dockerfile",
        "text/x-nginx-conf",
        "text/x-apache-conf",
        "text/x-systemd-unit",
        "text/x-tex",
        "text/x-latex",
        "text/x-bibtex",
        "text/x-rst",
        "text/x-asciidoc",
        "text/x-org",
        "text/troff",
        "text/rtf",
        "text/calendar",
        "text/vcard",
        # application/* text-based types
        "application/json",
        "application/xml",
        "application/javascript",
        "application/x-javascript",
        "application/ecmascript",
        "application/x-sh",
        "application/x-bash",
        "application/x-csh",
        "application/x-zsh",
        "application/x-python",
        "application/x-ruby",
        "application/x-perl",
        "application/x-php",
        "application/sql",
        "application/graphql",
        "application/toml",
        "application/x-yaml",
        "application/yaml",
        "application/x-httpd-php",
        "application/x-typescript",
        "application/typescript",
        "application/x-tex",
        "application/x-latex",
        "application/x-troff",
        "application/x-troff-man",
        "application/x-ndjson",
        "application/ld+json",
        "application/manifest+json",
        "application/schema+json",
        "application/vnd.api+json",
        "application/hal+json",
        "application/problem+json",
        "application/x-www-form-urlencoded",
        "application/xhtml+xml",
        "application/atom+xml",
        "application/rss+xml",
        "application/soap+xml",
        "application/mathml+xml",
        "application/xslt+xml",
        "application/x-subrip",
        "application/x-wine-extension-ini",
    }
)


def is_text_readable_mime(mime: str | None) -> bool:
    """Whether *mime* denotes a file whose bytes are directly readable as text.

    Covers the ``text/*`` family, an allowlist of text-based ``application/*``
    types, and ``+json`` / ``+xml`` structured suffixes. MIME parameters (e.g.
    ``; charset=utf-8``) and case are normalized away. Images and binary
    documents (pdf, office, xmind, ...) return ``False`` — their bytes are not
    directly readable as text.
    """
    if not mime:
        return False
    normalized = mime.split(";", 1)[0].strip().lower()
    if not normalized:
        return False
    if normalized.startswith("text/"):
        return True
    if normalized in TEXT_READABLE_MIME_TYPES:
        return True
    if normalized.endswith("+json") or normalized.endswith("+xml"):
        return True
    return False
