# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document skill loader tool.

This module provides the LoadDocumentSkillTool class that provides
step-by-step instructions for loading Anthropic's official document skills.

The tool returns mandatory instructions that the LLM MUST follow in order.
"""

import json
import logging
from typing import Any, ClassVar, Optional

from langchain_core.callbacks import AsyncCallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class LoadDocumentSkillInput(BaseModel):
    """Input schema for load_document_skill tool."""

    document_type: str = Field(
        ...,
        description='Type of document skill to load: "pptx", "xlsx", "docx", or "pdf"',
    )


class LoadDocumentSkillTool(BaseTool):
    """Tool for providing mandatory instructions to load Anthropic's document skills.

    This tool returns step-by-step instructions that MUST be followed in order.
    The LLM must execute each step using sandbox tools before proceeding.
    """

    name: str = "load_document_skill"
    display_name: str = "加载文档技能"
    description: str = """Get mandatory step-by-step instructions for loading Anthropic's official document skills.

⚠️ CRITICAL WARNINGS:
1. This tool returns MANDATORY steps that you MUST follow IN ORDER
2. You CANNOT skip any steps - each step is required
3. You MUST use sandbox tools to execute each step
4. Your existing knowledge about python-pptx/openpyxl/etc. may be OUTDATED
5. Anthropic's skills contain the LATEST and CORRECT instructions

Parameters:
- document_type (required): Type of skill to load ("pptx", "xlsx", "docx", "pdf")

What you receive:
- Mandatory step-by-step instructions
- File paths and commands to execute
- Validation criteria for each step

What you MUST do:
1. Execute step 1 using sandbox_list_files (check marketplace)
2. Execute step 2 using sandbox_command (install if needed)
3. Execute step 3 using sandbox_read_file (read skill documentation)
4. Only AFTER step 3, follow the loaded skill instructions

DO NOT generate documents based on your existing knowledge without loading the skill first.

Example:
{
  "document_type": "pptx"
}"""

    args_schema: type[BaseModel] = LoadDocumentSkillInput

    # Context from SkillToolContext
    task_id: int
    user_id: int
    user_name: str

    # Skill file paths in marketplace
    SKILL_PATHS: ClassVar[dict[str, str]] = {
        "pptx": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pptx/SKILL.md",
        "xlsx": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/xlsx/SKILL.md",
        "docx": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/docx/SKILL.md",
        "pdf": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pdf/SKILL.md",
    }

    MARKETPLACE_DIR: ClassVar[str] = (
        "/root/.claude/plugins/marketplaces/anthropic-agent-skills"
    )

    class Config:
        """Pydantic config."""

        arbitrary_types_allowed = True

    def _run(
        self,
        document_type: str,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("LoadDocumentSkillTool only supports async execution")

    async def _arun(
        self,
        document_type: str,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        """Provide mandatory step-by-step instructions.

        Args:
            document_type: Type of document (pptx, xlsx, docx, pdf)
            run_manager: Callback manager

        Returns:
            JSON string with mandatory instructions
        """
        logger.info(
            f"[LoadDocumentSkill] Providing mandatory instructions for {document_type}, "
            f"task_id={self.task_id}, user_id={self.user_id}, user_name={self.user_name}"
        )

        # Validate document type
        if document_type not in self.SKILL_PATHS:
            error_msg = (
                f"Invalid document_type: {document_type}. "
                f"Must be one of: {', '.join(self.SKILL_PATHS.keys())}"
            )
            logger.error(f"[LoadDocumentSkill] {error_msg}")
            return json.dumps({"success": False, "error": error_msg})

        skill_path = self.SKILL_PATHS[document_type]

        instructions = {
            "success": True,
            "document_type": document_type,
            "skill_file_path": skill_path,
            "marketplace_dir": self.MARKETPLACE_DIR,
            "mandatory_steps": {
                "⚠️ WARNING": (
                    "These steps are MANDATORY and MUST be executed IN ORDER. "
                    "DO NOT skip any step. DO NOT generate documents based on your existing knowledge. "
                    "Your knowledge about python-pptx/openpyxl/python-docx may be OUTDATED. "
                    "Anthropic's skills contain the LATEST instructions that you MUST follow."
                ),
                "step_1_CHECK_MARKETPLACE": {
                    "description": "Check if Anthropic skills marketplace exists",
                    "mandatory": True,
                    "tool": "sandbox_list_files",
                    "arguments": {"path": self.MARKETPLACE_DIR},
                    "expected_outcome": "success=true means marketplace exists, success=false means need step 2",
                    "next_step": "If success=false, proceed to step 2. If success=true, proceed to step 3.",
                },
                "step_2_INSTALL_MARKETPLACE": {
                    "description": "Install marketplace (ONLY if step 1 returned success=false)",
                    "mandatory": "conditional - required if step 1 failed",
                    "tool": "sandbox_command",
                    "arguments": {
                        "command": "claude plugin marketplace add anthropics/skills",
                        "working_dir": "/home/user",
                        "timeout_seconds": 300,
                    },
                    "expected_outcome": "exit_code=0 and success=true",
                    "validation": "Verify the command completed without errors",
                    "next_step": "After successful installation, proceed to step 3",
                },
                "step_3_READ_SKILL_DOCUMENTATION": {
                    "description": f"Read the {document_type.upper()} skill documentation file",
                    "mandatory": True,
                    "critical_importance": (
                        "⚠️ THIS IS THE MOST IMPORTANT STEP ⚠️\n"
                        "You MUST read this file to get the CORRECT and LATEST instructions.\n"
                        "DO NOT proceed to generate documents without reading this file.\n"
                        "The content field will contain Anthropic's official skill documentation."
                    ),
                    "tool": "sandbox_read_file",
                    "arguments": {"file_path": skill_path},
                    "expected_outcome": "success=true and content field contains the skill documentation",
                    "validation": "Verify content is not empty and contains skill instructions",
                    "next_step": "After reading, follow the instructions in the 'content' field to generate documents",
                },
                "step_4_FOLLOW_SKILL_INSTRUCTIONS": {
                    "description": "Follow the instructions from step 3's content field",
                    "mandatory": True,
                    "pre_installed_dependencies": {
                        "note": "Most common dependencies are already installed in the Docker image",
                        "system_packages": [
                            "LibreOffice (libreoffice-core, libreoffice-writer, libreoffice-calc, libreoffice-impress)",
                            "Poppler utilities (poppler-utils for pdftoppm)",
                            "Pandoc (for text extraction from documents)",
                            "tesseract (OCR engine for scanned PDFs)",
                            "Chromium browser (for playwright HTML rendering)",
                        ],
                        "python_packages": [
                            "python-pptx",
                            "openpyxl (best for complex formatting, formulas, and Excel-specific features)",
                            "pandas (best for data analysis, bulk operations, and simple data export)",
                            "python-docx",
                            "reportlab (for PDF creation)",
                            "pypdf (for merging and splitting PDFs)",
                            "pdfplumber (for extracting text and tables from PDFs)",
                            "pytesseract (for OCR on scanned PDFs)",
                            "Pillow",
                            "markitdown[pptx]",
                            "defusedxml",
                        ],
                        "npm_packages": [
                            "pptxgenjs",
                            "playwright",
                            "sharp",
                            "react",
                            "react-dom",
                            "react-icons",
                            "docx",
                            "pdf-lib (for filling PDF forms)",
                        ],
                        "environment": "NODE_PATH=/usr/lib/node_modules (npm packages available globally)",
                    },
                    "guidelines": [
                        "Read the skill documentation carefully",
                        "Check if dependencies are already installed (most common ones are pre-installed)",
                        "Only install additional dependencies if explicitly required by the documentation",
                        "Follow the code patterns and examples in the documentation",
                        "Use sandbox_write_file to create Python scripts",
                        "Use sandbox_command to execute generation scripts",
                        "Use sandbox_list_files to verify output files",
                    ],
                    "forbidden": [
                        "❌ DO NOT skip reading the documentation and generate based on your knowledge",
                        "❌ DO NOT use outdated patterns not specified in the documentation",
                        "❌ DO NOT assume you know the correct approach without reading",
                    ],
                },
            },
            "critical_reminder": {
                "importance": "HIGHEST PRIORITY",
                "rules": [
                    "1. Execute ALL steps in order - no skipping allowed",
                    "2. Step 3 (reading skill documentation) is MANDATORY - never skip it",
                    "3. Your existing knowledge may be OUTDATED - trust Anthropic's documentation",
                    "4. Generate documents ONLY after completing step 3",
                    "5. Follow the EXACT patterns from the loaded skill documentation",
                ],
            },
            "message": (
                f"🔴 MANDATORY INSTRUCTIONS FOR {document_type.upper()} GENERATION 🔴\n\n"
                f"You MUST execute these steps IN ORDER:\n\n"
                f"1️⃣ STEP 1: Check marketplace\n"
                f"   → Call: sandbox_list_files(path='{self.MARKETPLACE_DIR}')\n"
                f"   → If fails, proceed to step 2. If succeeds, skip to step 3.\n\n"
                f"2️⃣ STEP 2: Install marketplace (only if step 1 failed)\n"
                f"   → Call: sandbox_command(command='claude plugin marketplace add anthropics/skills')\n"
                f"   → Wait for completion\n\n"
                f"3️⃣ STEP 3: ⚠️ READ SKILL DOCUMENTATION ⚠️ (NEVER SKIP THIS)\n"
                f"   → Call: sandbox_read_file(file_path='{skill_path}')\n"
                f"   → Read the 'content' field - this contains Anthropic's LATEST instructions\n"
                f"   → This is MANDATORY - your knowledge may be outdated\n\n"
                f"4️⃣ STEP 4: Follow the loaded instructions\n"
                f"   → Use the patterns from step 3's content\n"
                f"   → Most common dependencies are already pre-installed (python-pptx, openpyxl, pandas, python-docx, reportlab, pandoc, docx, LibreOffice, Chromium, etc.)\n"
                f"   → Only install additional dependencies if explicitly required\n"
                f"   → Generate the document following the loaded instructions\n\n"
                f"⚠️ DO NOT generate {document_type.upper()} files before completing step 3!\n"
                f"⚠️ Your existing knowledge may be OUTDATED - trust the loaded documentation!"
            ),
        }

        logger.info(
            f"[LoadDocumentSkill] Provided mandatory instructions for {document_type}"
        )

        return json.dumps(instructions, ensure_ascii=False, indent=2)
