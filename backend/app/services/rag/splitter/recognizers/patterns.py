# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Regex patterns for structure recognition.

All patterns are organized by structure type and include both
detection and extraction capabilities.
"""

import re
from typing import Dict, Pattern

# Heading patterns
HEADING_PATTERNS: Dict[str, Pattern] = {
    # Markdown headings
    "markdown_atx": re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE),
    # Setext-style headings (= for h1, - for h2)
    "setext_h1": re.compile(r"^(.+)\n={3,}$", re.MULTILINE),
    "setext_h2": re.compile(r"^(.+)\n-{3,}$", re.MULTILINE),
    # All caps headings (common in plain text/PDF)
    "all_caps": re.compile(r"^[A-Z][A-Z\s\d\.\-:]{2,}$"),
    # Numbered headings (1., 1.1, 1.1.1)
    "numbered": re.compile(r"^(\d+(?:\.\d+)*)\s+([A-Z][A-Za-z].*)$"),
}

# Code block patterns
CODE_BLOCK_PATTERNS: Dict[str, Pattern] = {
    # Fenced code blocks (```)
    "fenced_start": re.compile(r"^```(\w*)\s*$"),
    "fenced_end": re.compile(r"^```\s*$"),
    # Indented code blocks (4+ spaces or tab)
    "indented": re.compile(r"^(?:\s{4,}|\t)(.+)$"),
    # XML/HTML code tags
    "xml_code": re.compile(r"<code[^>]*>(.*?)</code>", re.DOTALL | re.IGNORECASE),
    "xml_pre": re.compile(r"<pre[^>]*>(.*?)</pre>", re.DOTALL | re.IGNORECASE),
}

# Table patterns
TABLE_PATTERNS: Dict[str, Pattern] = {
    # Markdown table row
    "markdown_row": re.compile(r"^\|(.+)\|$"),
    # Markdown table separator
    "markdown_separator": re.compile(r"^\|[\s\-:|]+\|$"),
    # ASCII table borders
    "ascii_border": re.compile(r"^[+\-]+$"),
    # Tab-separated (3+ tabs indicate table)
    "tab_separated": re.compile(r"^[^\t]+(?:\t[^\t]+){2,}$"),
    # Multiple space separated (3+ columns)
    "space_separated": re.compile(r"^\S+(?:\s{3,}\S+){2,}$"),
}

# List patterns
LIST_PATTERNS: Dict[str, Pattern] = {
    # Unordered list markers
    "bullet_dash": re.compile(r"^(\s*)-\s+(.*)$"),
    "bullet_asterisk": re.compile(r"^(\s*)\*\s+(.*)$"),
    "bullet_plus": re.compile(r"^(\s*)\+\s+(.*)$"),
    # Ordered list markers
    "numbered_dot": re.compile(r"^(\s*)(\d+)\.\s+(.*)$"),
    "numbered_paren": re.compile(r"^(\s*)(\d+)\)\s+(.*)$"),
    "letter_dot": re.compile(r"^(\s*)([a-zA-Z])\.\s+(.*)$"),
    "letter_paren": re.compile(r"^(\s*)([a-zA-Z])\)\s+(.*)$"),
    # Chinese list markers
    "chinese_number": re.compile(r"^(\s*)([一二三四五六七八九十]+)[、.]\s*(.*)$"),
}

# Q&A patterns
QA_PATTERNS: Dict[str, Pattern] = {
    # Q: A: format
    "q_colon": re.compile(r"^[QqQq问][:：]\s*(.+)$"),
    "a_colon": re.compile(r"^[AaAa答][:：]\s*(.+)$"),
    # Question/Answer labels
    "question_label": re.compile(
        r"^(?:问题|Question|Q)\s*[:\d.]*\s*(.+)$", re.IGNORECASE
    ),
    "answer_label": re.compile(
        r"^(?:回答|答案|Answer|A)\s*[:\d.]*\s*(.+)$", re.IGNORECASE
    ),
    # FAQ format
    "faq_q": re.compile(r"^(?:FAQ|常见问题)\s*[:\d.]*\s*(.+)$", re.IGNORECASE),
}

# Flow/Process patterns (conditional logic)
FLOW_PATTERNS: Dict[str, Pattern] = {
    # Arrow notation
    "arrow_simple": re.compile(r"(.+?)\s*[-=]>\s*(.+)"),
    "arrow_unicode": re.compile(r"(.+?)\s*[→⇒]\s*(.+)"),
    # If-then patterns
    "if_then": re.compile(
        r"^(?:如果|若|if|when)\s*(.+?)\s*[,，]\s*(?:则|就|then)\s*(.+)$", re.IGNORECASE
    ),
    # When-do patterns
    "when_do": re.compile(r"^当\s*(.+?)\s*时[,，]?\s*(.+)$"),
    # Conditional markers
    "condition": re.compile(
        r"^(?:条件|前提|Condition|Prerequisite)\s*[:：]?\s*(.+)$", re.IGNORECASE
    ),
    "result": re.compile(
        r"^(?:结果|结论|Result|Conclusion)\s*[:：]?\s*(.+)$", re.IGNORECASE
    ),
}

# Blockquote patterns
BLOCKQUOTE_PATTERNS: Dict[str, Pattern] = {
    # Markdown blockquote
    "markdown": re.compile(r"^(>+)\s*(.*)$"),
    # Chinese quote marks (using unicode escapes for safety)
    "chinese_quote_start": re.compile(r"^[\u300c\u300e\u201c\u2018]\s*(.*)$"),
    "chinese_quote_end": re.compile(r"^(.*)\s*[\u300d\u300f\u201d\u2019]$"),
}

# Definition patterns
DEFINITION_PATTERNS: Dict[str, Pattern] = {
    # Term: Definition format
    "colon_definition": re.compile(r"^([^:：]+)[:：]\s+(.+)$"),
    # Markdown definition (: at start of line)
    "markdown_definition": re.compile(r"^:\s+(.+)$"),
    # Glossary format
    "glossary": re.compile(r"^\*\*([^*]+)\*\*\s*[-:：]\s*(.+)$"),
    # Term (parenthetical definition)
    "parenthetical": re.compile(r"^([^(（]+)\s*[(（]([^)）]+)[)）]$"),
}

# Noise patterns (for filtering)
NOISE_PATTERNS: Dict[str, Pattern] = {
    # Page numbers
    "page_number": re.compile(r"^\s*[-—]\s*\d+\s*[-—]\s*$"),
    "page_number_of": re.compile(r"^\s*\d+\s*/\s*\d+\s*$"),  # 5/10 format
    "page_marker": re.compile(r"^---\s*Page\s+\d+\s*---$", re.IGNORECASE),
    # Headers/Footers (repeated short lines)
    "copyright": re.compile(r"(?:copyright|版权|©)", re.IGNORECASE),
    "confidential": re.compile(r"(?:confidential|机密|保密)", re.IGNORECASE),
    # Table of contents markers
    "toc_marker": re.compile(
        r"^\s*(?:目录|Contents|Table of Contents)\s*$", re.IGNORECASE
    ),
    "toc_entry": re.compile(r"^.{2,50}\s*[.…·]+\s*\d+\s*$"),  # Title ...... 15
    # Horizontal rules
    "horizontal_rule": re.compile(r"^[-*_=]{3,}\s*$"),
    # Empty or whitespace-only
    "whitespace_only": re.compile(r"^\s*$"),
}
