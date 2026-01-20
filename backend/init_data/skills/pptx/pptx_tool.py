# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""PPTX generation tool for the pptx skill."""

from __future__ import annotations

import json
import logging
from io import BytesIO
from typing import Any, Optional

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SlideInput(BaseModel):
    """Schema for a single slide."""

    title: str = Field(description="Slide title")
    content: str = Field(
        description="Slide content in markdown format (use - or * for bullets)"
    )
    notes: Optional[str] = Field(default=None, description="Speaker notes")
    layout: str = Field(
        default="title_and_content",
        description="Layout: 'title', 'title_and_content', 'two_column', 'blank'",
    )


class PPTXGenerateInput(BaseModel):
    """Input schema for PPTX generation tool."""

    title: str = Field(description="Presentation title")
    slides: list[dict[str, Any]] = Field(
        description="Array of slide objects with title, content, optional notes and layout"
    )
    author: Optional[str] = Field(default=None, description="Author name")
    theme: str = Field(
        default="default",
        description="Theme: 'default', 'professional', 'creative', 'minimal'",
    )


class PPTXGenerateTool(BaseTool):
    """Tool for generating PowerPoint presentations."""

    name: str = "generate_pptx"
    display_name: str = "Generate PPTX"
    description: str = (
        "Generate a PowerPoint presentation from structured content. "
        "Provide title, slides array (each with title, content as markdown), "
        "optional author, and theme."
    )
    args_schema: type[BaseModel] = PPTXGenerateInput

    # Configuration
    task_id: int = 0
    subtask_id: int = 0
    user_id: int = 0
    user_name: str = ""
    ws_emitter: Any = None
    max_slides: int = 50
    timeout: int = 120

    def __init__(
        self,
        task_id: int = 0,
        subtask_id: int = 0,
        user_id: int = 0,
        user_name: str = "",
        ws_emitter: Any = None,
        max_slides: int = 50,
        timeout: int = 120,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.user_id = user_id
        self.user_name = user_name
        self.ws_emitter = ws_emitter
        self.max_slides = max_slides
        self.timeout = timeout

    def _run(
        self,
        title: str,
        slides: list[dict[str, Any]],
        author: Optional[str] = None,
        theme: str = "default",
        **_,
    ) -> str:
        """Synchronous execution."""
        import asyncio

        return asyncio.get_event_loop().run_until_complete(
            self._arun(title, slides, author, theme)
        )

    async def _arun(
        self,
        title: str,
        slides: list[dict[str, Any]],
        author: Optional[str] = None,
        theme: str = "default",
        **_,
    ) -> str:
        """Generate PPTX asynchronously."""
        try:
            # Validate input
            if not title:
                return json.dumps(
                    {"status": "error", "error": "Presentation title is required"},
                    ensure_ascii=False,
                )
            if not slides:
                return json.dumps(
                    {"status": "error", "error": "At least one slide is required"},
                    ensure_ascii=False,
                )
            if len(slides) > self.max_slides:
                return json.dumps(
                    {
                        "status": "error",
                        "error": f"Too many slides. Maximum allowed: {self.max_slides}",
                    },
                    ensure_ascii=False,
                )

            # Emit progress if ws_emitter available
            if self.ws_emitter:
                await self._emit_progress("starting", f"Generating '{title}'...")

            # Generate PPTX
            pptx_binary, slide_count = self._generate_pptx(
                title=title,
                slides=slides,
                author=author or self.user_name,
                theme=theme,
            )

            # Try to store via backend API
            result = await self._store_pptx(title, pptx_binary, slide_count)

            if self.ws_emitter:
                await self._emit_progress("completed", f"Generated {slide_count} slides")

            return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.exception(f"PPTX generation failed: {e}")
            return json.dumps(
                {"status": "error", "error": f"Generation failed: {str(e)}"},
                ensure_ascii=False,
            )

    def _generate_pptx(
        self,
        title: str,
        slides: list[dict[str, Any]],
        author: str,
        theme: str,
    ) -> tuple[bytes, int]:
        """Generate PPTX binary using python-pptx."""
        from pptx import Presentation
        from pptx.dml.color import RGBColor
        from pptx.enum.text import PP_ALIGN
        from pptx.util import Inches, Pt

        # Theme colors
        themes = {
            "default": {"primary": "1F497D", "secondary": "4F81BD", "text": "333333"},
            "professional": {
                "primary": "2C3E50",
                "secondary": "3498DB",
                "text": "2C3E50",
            },
            "creative": {"primary": "E74C3C", "secondary": "F39C12", "text": "333333"},
            "minimal": {"primary": "333333", "secondary": "666666", "text": "333333"},
        }
        colors = themes.get(theme, themes["default"])

        # Create presentation
        prs = Presentation()
        prs.slide_width = Inches(13.333)  # 16:9
        prs.slide_height = Inches(7.5)

        # Title slide
        title_slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank

        title_box = title_slide.shapes.add_textbox(
            Inches(0.5), Inches(2.5), Inches(12.333), Inches(1.5)
        )
        tf = title_box.text_frame
        p = tf.paragraphs[0]
        p.text = title
        p.font.size = Pt(44)
        p.font.bold = True
        p.font.color.rgb = RGBColor.from_string(colors["primary"])
        p.alignment = PP_ALIGN.CENTER

        if author:
            author_box = title_slide.shapes.add_textbox(
                Inches(0.5), Inches(4.5), Inches(12.333), Inches(0.5)
            )
            af = author_box.text_frame
            ap = af.paragraphs[0]
            ap.text = author
            ap.font.size = Pt(20)
            ap.font.color.rgb = RGBColor.from_string(colors["secondary"])
            ap.alignment = PP_ALIGN.CENTER

        # Content slides
        for slide_data in slides:
            slide_title = slide_data.get("title", "")
            content = slide_data.get("content", "")
            notes = slide_data.get("notes", "")

            content_slide = prs.slides.add_slide(prs.slide_layouts[6])

            # Slide title
            if slide_title:
                stb = content_slide.shapes.add_textbox(
                    Inches(0.5), Inches(0.3), Inches(12.333), Inches(1)
                )
                stf = stb.text_frame
                sp = stf.paragraphs[0]
                sp.text = slide_title
                sp.font.size = Pt(32)
                sp.font.bold = True
                sp.font.color.rgb = RGBColor.from_string(colors["primary"])

            # Slide content
            if content:
                cb = content_slide.shapes.add_textbox(
                    Inches(0.5), Inches(1.5), Inches(12.333), Inches(5.5)
                )
                cf = cb.text_frame
                cf.word_wrap = True

                lines = content.strip().split("\n")
                for i, line in enumerate(lines):
                    if i == 0:
                        cp = cf.paragraphs[0]
                    else:
                        cp = cf.add_paragraph()

                    line_text = line.strip()
                    # Handle bullets
                    if line_text.startswith("- ") or line_text.startswith("* "):
                        cp.text = "• " + line_text[2:]
                        cp.level = 0
                    elif line_text.startswith("  - ") or line_text.startswith("  * "):
                        cp.text = "  • " + line_text[4:]
                        cp.level = 1
                    else:
                        cp.text = line_text

                    cp.font.size = Pt(20)
                    cp.font.color.rgb = RGBColor.from_string(colors["text"])

            # Speaker notes
            if notes and content_slide.has_notes_slide:
                notes_slide = content_slide.notes_slide
                notes_frame = notes_slide.notes_text_frame
                notes_frame.text = notes

        # Save to bytes
        output = BytesIO()
        prs.save(output)
        return output.getvalue(), len(slides) + 1

    async def _store_pptx(
        self,
        title: str,
        pptx_binary: bytes,
        slide_count: int,
    ) -> dict[str, Any]:
        """Store PPTX via backend API or return base64."""
        import base64
        import os

        import httpx

        filename = f"{title.replace(' ', '_')}.pptx"
        api_url = os.environ.get("BACKEND_API_URL", "http://localhost:8000")
        auth_token = os.environ.get("TASK_AUTH_TOKEN", "")

        if api_url and auth_token:
            try:
                async with httpx.AsyncClient(timeout=60.0) as client:
                    files = {
                        "file": (
                            filename,
                            pptx_binary,
                            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                        )
                    }
                    headers = {"Authorization": f"Bearer {auth_token}"}

                    response = await client.post(
                        f"{api_url}/api/attachments/upload",
                        files=files,
                        headers=headers,
                    )

                    if response.status_code == 200:
                        data = response.json()
                        return {
                            "status": "success",
                            "message": f"Generated presentation '{title}' with {slide_count} slides",
                            "pptx_context_id": data.get("id"),
                            "filename": filename,
                            "slide_count": slide_count,
                            "file_size": len(pptx_binary),
                            "download_url": f"/api/attachments/{data.get('id')}/download",
                        }
            except Exception as e:
                logger.warning(f"Failed to store via API: {e}")

        # Fallback: return base64
        return {
            "status": "success",
            "message": f"Generated presentation '{title}' with {slide_count} slides",
            "filename": filename,
            "slide_count": slide_count,
            "file_size": len(pptx_binary),
            "pptx_base64": base64.b64encode(pptx_binary).decode("utf-8"),
            "note": "Download by decoding base64 and saving as .pptx",
        }

    async def _emit_progress(self, status: str, message: str) -> None:
        """Emit progress via WebSocket."""
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_output={"status": status, "message": message},
                    status=status,
                )
            except Exception:
                pass
