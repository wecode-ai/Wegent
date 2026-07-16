# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Single source of truth for multimodal analysis default prompts.

Imported by BOTH:
- backend (serves these defaults to the frontend via the
  ``GET /knowledge-bases/multimodal-default-prompts`` API, used to prefill
  prompt editors in the KB create/edit, upload advanced settings, and
  re-analyze dialogs), and
- knowledge_doc_converter (the fallback when no ``prompt_override`` is supplied
  with the Celery task payload).

Keeping one copy here prevents the two services from drifting.
"""

from __future__ import annotations

DEFAULT_VIDEO_PROMPT = """Analyze the provided video in detail and produce a structured Markdown summary capturing its visual, audio, and textual content, with precise timestamps, for retrieval (RAG)."""

DEFAULT_IMAGE_PROMPT = """Analyze the provided image in detail and produce a structured Markdown summary capturing its visual composition, core text (OCR), and underlying intent, for retrieval (RAG)."""
