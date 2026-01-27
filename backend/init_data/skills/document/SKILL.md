---
description: "Provides step-by-step instructions to load and use Anthropic's official document generation skills (PPTX, XLSX, DOCX, PDF). Guides you through checking marketplace installation, reading skill documentation, and generating professional documents in sandbox environment."
displayName: "文档生成"
version: "1.0.0"
author: "Wegent Team"
tags: ["document", "pptx", "xlsx", "docx", "pdf", "sandbox"]
bindShells: ["Chat"]
provider:
  module: provider
  class: DocumentToolProvider
dependencies:
  - sandbox
tools:
  - name: load_document_skill
    provider: document
    config:
      timeout: 300
---

# Document Generation Skill

Provides **mandatory step-by-step instructions** to load Anthropic's official document generation skills for creating professional PowerPoint presentations (PPTX), Excel spreadsheets (XLSX), Word documents (DOCX), and PDF files.

## Overview

This skill guides you through the process of using Anthropic's official document skills (pre-installed in Docker):

1. **Read Skill Documentation**: Use `sandbox_read_file` to read the official skill instructions
2. **Follow Instructions**: Generate documents according to the loaded skill documentation
3. **Upload and Return URL**: Upload generated documents and provide download URLs to users

**⚠️ CRITICAL: This tool provides MANDATORY instructions that you MUST follow IN ORDER.**

You must execute each step using sandbox tools. Do NOT skip reading the skill documentation - your existing knowledge about document generation libraries may be outdated. Always trust Anthropic's official documentation.

## Core Capabilities

- **PowerPoint (PPTX)**: Create presentations with slides, charts, images, and formatting
- **Excel (XLSX)**: Generate spreadsheets with formulas, charts, pivot tables, and formatting
- **Word (DOCX)**: Create professional documents with styles, tables, images, and formatting
- **PDF**: Generate PDF files from various sources or create new PDFs

**Note**: All required dependencies (LibreOffice, Poppler, Chromium, python-pptx, openpyxl, python-docx, reportlab, markitdown, pptxgenjs, playwright, sharp, react, etc.) are pre-installed in the Docker executor image. See [Pre-installed Dependencies](#pre-installed-dependencies) for the complete list.

## When to Use

Use this skill when you need to:

- ✅ Create PowerPoint presentations
- ✅ Generate Excel spreadsheets with data analysis
- ✅ Produce Word documents with rich formatting
- ✅ Create or convert files to PDF format
- ✅ Learn how to use Python document generation libraries

## Available Tools

### `load_document_skill`

Get mandatory step-by-step instructions for loading a specific document skill.

**⚠️ CRITICAL WARNINGS:**
1. This tool returns **MANDATORY steps** that you **MUST follow IN ORDER**
2. You **CANNOT skip any steps** - each step is required
3. You **MUST use sandbox tools** to execute each step
4. **DO NOT use 'claude' command** - it's not available for all models
5. **DO NOT use 'sandbox_claude' tool** for document generation
6. Your existing knowledge about python-pptx/openpyxl/python-docx may be **OUTDATED**
7. Anthropic's skills contain the **LATEST and CORRECT** instructions
8. **IMPORTANT**: Follow the design guidelines in the skill documentation to generate **visually appealing, professional-looking documents**

**Parameters:**
- `document_type` (required): Type of document skill to load
  - Options: `"pptx"`, `"xlsx"`, `"docx"`, `"pdf"`

**What You Receive:**
- Mandatory step-by-step instructions
- File paths to Anthropic's skill documentation
- Commands to execute with sandbox tools
- Validation criteria for each step

**What You MUST Do:**

1. **Step 1**: ⚠️ **NEVER SKIP THIS** - Execute `sandbox_read_file` to read the skill documentation
2. **Step 2**: Only AFTER reading, follow the loaded skill instructions to generate documents
   - ⚠️ Follow the design guidelines and best practices in the skill documentation
   - ⚠️ Generate visually appealing, professional-looking documents with proper styling
   - DO NOT use 'claude' command or 'sandbox_claude' tool
3. **Step 3**: ⚠️ **NEVER SKIP THIS** - Upload the generated document using `sandbox_upload_attachment` and return the download URL to the user

**DO NOT** generate documents based on your existing knowledge without loading the skill first.
**DO NOT** just tell the user the file path - they cannot access sandbox files directly.
**DO NOT** use 'claude' command or 'sandbox_claude' tool for document generation.

**Example Usage:**

```json
{
  "name": "load_document_skill",
  "arguments": {
    "document_type": "pptx"
  }
}
```

**Example Response:**
```json
{
  "success": true,
  "document_type": "pptx",
  "skill_file_path": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pptx/SKILL.md",
  "marketplace_dir": "/root/.claude/plugins/marketplaces/anthropic-agent-skills",
  "mandatory_steps": {
    "⚠️ WARNING": "These steps are MANDATORY...",
    "step_1_READ_SKILL_DOCUMENTATION": {
      "description": "Read PPTX skill documentation",
      "tool": "sandbox_read_file",
      "arguments": {"file_path": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pptx/SKILL.md"},
      "critical_importance": "⚠️ THIS IS THE MOST IMPORTANT STEP ⚠️"
    },
    "step_2_FOLLOW_SKILL_INSTRUCTIONS": {
      "description": "Follow the instructions from step 1",
      "forbidden": [
        "❌ DO NOT use 'claude' command - it's not available for all models",
        "❌ DO NOT use 'sandbox_claude' tool for document generation"
      ]
    },
    "step_3_UPLOAD_AND_RETURN_URL": {
      "description": "Upload document and return download URL to user",
      "tool": "sandbox_upload_attachment",
      "critical_importance": "⚠️ THIS STEP IS MANDATORY - users cannot access sandbox files directly ⚠️"
    }
  },
  "message": "🔴 MANDATORY INSTRUCTIONS FOR PPTX GENERATION 🔴..."
}
```

**Complete Workflow:**

1. **Call the tool** to get mandatory instructions
   ```json
   {"name": "load_document_skill", "arguments": {"document_type": "pptx"}}
   ```

2. **Execute Step 1** - ⚠️ **MANDATORY** - Read skill documentation
   ```json
   {"name": "sandbox_read_file", "arguments": {"file_path": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pptx/SKILL.md"}}
   ```

3. **Follow Step 2** - Use the instructions from step 1 to:
   - Install dependencies if needed: `sandbox_command` with `pip install python-pptx`
   - Create generation script: `sandbox_write_file` with your Python code
   - ⚠️ Follow the design guidelines and best practices in the skill documentation
   - ⚠️ Generate visually appealing, professional-looking documents with proper styling
   - Execute script: `sandbox_command` with `python /home/user/generate_ppt.py`
   - Verify output: `sandbox_list_files` to check generated files
   - ⚠️ **DO NOT use 'claude' command or 'sandbox_claude' tool**

4. **Execute Step 3** - ⚠️ **MANDATORY** - Upload and return download URL
   ```json
   {"name": "sandbox_upload_attachment", "arguments": {"file_path": "/home/user/documents/ai_trends.pptx"}}
   ```

   Then present the download link to user:
   ```
   Document generation completed!

   📄 **ai_trends.pptx**

   [Click to Download](/api/attachments/123/download)
   ```

## How It Works

The `load_document_skill` tool operates as an **instruction provider**, NOT an executor:

1. **Validates Input**: Checks if `document_type` is valid (pptx/xlsx/docx/pdf)

2. **Returns Instructions**: Provides structured JSON with mandatory steps:
   - Step 1: How to read the official skill documentation (Anthropic skills are pre-installed in Docker)
   - Step 2: Guidelines for following the loaded instructions (includes design best practices for professional-looking documents, DO NOT use 'claude' command or 'sandbox_claude' tool)
   - Step 3: How to upload and return download URL to user

3. **You Execute**: You must execute each step using sandbox tools

### Skill File Locations

Based on `document_type`, the tool provides paths to Anthropic's official skills:

- **PPTX**: `/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pptx/SKILL.md`
- **XLSX**: `/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/xlsx/SKILL.md`
- **DOCX**: `/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/docx/SKILL.md`
- **PDF**: `/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pdf/SKILL.md`

### What You Learn From Skill Documentation

After reading the skill file in Step 1, you'll receive:
- Python library documentation and APIs
- Code examples for common document generation tasks
- Best practices and recommended patterns
- Installation commands for required dependencies
- Troubleshooting guidance

**You then implement the document generation yourself using sandbox tools.**

## Best Practices

1. **Always Call load_document_skill First**: Get instructions before attempting any document generation
2. **Never Skip Step 1**: Always read the official skill documentation - your knowledge may be outdated
3. **Follow Design Guidelines**: Pay attention to the design best practices in the skill documentation
4. **Generate Professional Documents**: Ensure documents are visually appealing with proper styling, colors, and formatting
5. **Never Skip Step 3**: Always upload documents and provide download URLs - users cannot access sandbox files
6. **Never Use Claude Command**: DO NOT use 'claude' command or 'sandbox_claude' tool for document generation
7. **Follow Steps In Order**: Execute step 1 → step 2 → step 3
8. **Install Dependencies in Sandbox**: Use `sandbox_command` to install required Python packages if needed
9. **Test Incrementally**: Start with simple documents, then add complexity
10. **Save to User Directory**: Use `/home/user/documents/` or subdirectories for output files
11. **Trust Official Documentation**: Anthropic's skills contain the latest library usage patterns and design guidelines

## Key Reminders

⚠️ **CRITICAL RULES:**
- DO NOT skip reading skill documentation (Step 1)
- DO NOT skip uploading and returning download URL (Step 3)
- DO NOT use 'claude' command - it's not available for all models
- DO NOT use 'sandbox_claude' tool for document generation
- DO NOT generate documents based solely on your existing knowledge
- DO NOT assume you know the correct approach without reading the instructions
- DO NOT just tell the user the file path - they cannot access sandbox files directly
- Your knowledge about python-pptx/openpyxl/python-docx may be OUTDATED
- ALWAYS follow the design guidelines in the skill documentation
- ALWAYS generate visually appealing, professional-looking documents
- ALWAYS follow the mandatory workflow

## Limitations

- **Anthropic Skills Pre-installed**: Anthropic's official skills are pre-installed in Docker, no installation needed
- **Sandbox Environment Only**: Skills are loaded from sandbox environment at `/root/.claude/plugins/marketplaces/`
- **Manual Execution Required**: You must execute each step using sandbox tools - the tool only provides instructions
- **Claude Command Not Universal**: 'claude' command and 'sandbox_claude' tool are not available for all AI models

## Troubleshooting

### Problem: Skill File Not Found
- **Symptom**: `sandbox_read_file` returns error when reading SKILL.md
- **Cause**: File path incorrect or skills not properly installed in Docker image
- **Solution**:
  - Verify file path in tool response
  - Check if Anthropic skills are included in Docker image
  - Use `sandbox_list_files` to verify the marketplace directory exists

### Problem: Tool Returns Timeout
- **Symptom**: `load_document_skill` times out after 300 seconds
- **Cause**: Network slow or internal processing delay
- **Solution**: Retry the tool call - the tool itself is lightweight and should respond quickly

### Problem: LLM Skips Reading Documentation
- **Symptom**: Documents generated incorrectly or using outdated patterns
- **Cause**: Skipped Step 1 (reading skill documentation)
- **Solution**: Always execute Step 1 - use `sandbox_read_file` to read the official documentation before generating documents

### Problem: LLM Uses Claude Command
- **Symptom**: Error "claude: command not found" or similar
- **Cause**: Used 'claude' command or 'sandbox_claude' tool which is not available for all models
- **Solution**: DO NOT use 'claude' command or 'sandbox_claude' tool - use Python libraries directly with `sandbox_command`

## Examples

### Example 1: Generate PowerPoint Presentation

**User Request**: "Create a business presentation about AI trends"

**Your Workflow:**

```json
// Step 1: Get instructions
{"name": "load_document_skill", "arguments": {"document_type": "pptx"}}

// Step 2: Read PPTX skill (execute step 1 from response)
{"name": "sandbox_read_file", "arguments": {"file_path": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pptx/SKILL.md"}}

// Step 3: After reading, follow the loaded instructions
// Install dependencies if needed
{"name": "sandbox_command", "arguments": {"command": "pip install python-pptx"}}

// Create generation script
{"name": "sandbox_write_file", "arguments": {
  "file_path": "/home/user/generate_ai_trends.py",
  "content": "from pptx import Presentation\nfrom pptx.util import Inches, Pt\n\n# Create presentation\nprs = Presentation()\n\n# Title slide\ntitle_slide = prs.slides.add_slide(prs.slide_layouts[0])\ntitle = title_slide.shapes.title\ntitle.text = 'AI Trends 2025'\n\n# Save\nprs.save('/home/user/documents/ai_trends.pptx')"
}}

// Execute script
{"name": "sandbox_command", "arguments": {"command": "python /home/user/generate_ai_trends.py"}}

// Verify output
{"name": "sandbox_list_files", "arguments": {"path": "/home/user/documents"}}

// Step 4: Upload document and return download URL
{"name": "sandbox_upload_attachment", "arguments": {"file_path": "/home/user/documents/ai_trends.pptx"}}
// Then present download link to user:
// Document generation completed!
// 📄 **ai_trends.pptx**
// [Click to Download](/api/attachments/123/download)
```

### Example 2: Generate Excel Spreadsheet

**User Request**: "Create a financial report spreadsheet"

```json
// Step 1: Get instructions
{"name": "load_document_skill", "arguments": {"document_type": "xlsx"}}

// Step 2: Read XLSX skill documentation
{"name": "sandbox_read_file", "arguments": {"file_path": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/xlsx/SKILL.md"}}

// Step 3: Install dependencies if needed and generate based on loaded instructions
{"name": "sandbox_command", "arguments": {"command": "pip install openpyxl"}}
// ... create script and execute ...

// Step 4: Upload and return download URL
{"name": "sandbox_upload_attachment", "arguments": {"file_path": "/home/user/documents/financial_report.xlsx"}}
```

### Example 3: Generate Word Document

**User Request**: "Create API documentation in DOCX format"

```json
// Step 1: Get instructions
{"name": "load_document_skill", "arguments": {"document_type": "docx"}}

// Step 2: Read DOCX skill documentation
{"name": "sandbox_read_file", "arguments": {"file_path": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/docx/SKILL.md"}}

// Step 3: Install dependencies if needed and generate based on loaded instructions
{"name": "sandbox_command", "arguments": {"command": "pip install python-docx"}}
// ... create script and execute ...

// Step 4: Upload and return download URL
{"name": "sandbox_upload_attachment", "arguments": {"file_path": "/home/user/documents/api_docs.docx"}}
```

### Example 4: Generate PDF Document

**User Request**: "Generate a research report as PDF"

```json
// Step 1: Get instructions
{"name": "load_document_skill", "arguments": {"document_type": "pdf"}}

// Step 2: Read PDF skill documentation
{"name": "sandbox_read_file", "arguments": {"file_path": "/root/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pdf/SKILL.md"}}

// Step 3: Install dependencies if needed and generate based on loaded instructions
{"name": "sandbox_command", "arguments": {"command": "pip install reportlab"}}
// ... create script and execute ...

// Step 4: Upload and return download URL
{"name": "sandbox_upload_attachment", "arguments": {"file_path": "/home/user/documents/research_report.pdf"}}
```

## Integration with Other Skills

This skill has a hard dependency on:

- **Sandbox Skill**: Required for all operations - provides `sandbox_list_files`, `sandbox_command`, `sandbox_read_file`, `sandbox_write_file`, and `sandbox_upload_attachment` tools

The sandbox skill is automatically loaded before this skill due to the `dependencies` declaration.

## Security Considerations

- All operations execute in isolated sandbox containers
- No access to host filesystem - only sandbox environment at `/home/user/`
- Marketplace code is from official Anthropic repository (`anthropics/skills`)
- All tool calls are logged for audit purposes

## Technical Notes

### Pre-installed Dependencies

The following dependencies are pre-installed in the Docker executor image to avoid runtime delays:

**System Packages (via dnf):**
```bash
# LibreOffice for document conversion and PDF operations
dnf install -y libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress

# Poppler utilities for PDF to image conversion
dnf install -y poppler-utils

# Pandoc for text extraction from documents
dnf install -y pandoc

# OCR engine for scanned PDFs
dnf install -y tesseract
```

**Claude Marketplace:**
```bash
claude plugin marketplace add anthropics/skills
```

**NPM Packages (globally installed):**
```bash
npm install -g pptxgenjs    # For creating presentations via html2pptx
npm install -g playwright   # For HTML rendering in html2pptx
npm install -g sharp        # For SVG rasterization and image processing
npm install -g react react-dom react-icons  # For React components and icons
npm install -g docx         # For creating new Word documents
npm install -g pdf-lib      # For filling PDF forms

# Playwright browser binaries
npx playwright install chromium  # Chromium browser for HTML rendering
```

**Python Packages:**
```bash
pip install python-pptx           # For PowerPoint generation
pip install openpyxl              # For Excel spreadsheet operations (best for complex formatting, formulas, and Excel-specific features)
pip install pandas                # For data analysis, bulk operations, and simple data export
pip install python-docx           # For Word document generation
pip install reportlab             # For PDF creation
pip install pypdf                 # For merging and splitting PDFs
pip install pdfplumber            # For extracting text and tables from PDFs
pip install pytesseract           # For OCR on scanned PDFs
pip install Pillow                # For image processing
pip install "markitdown[pptx]"    # For text extraction from presentations
pip install defusedxml            # For secure XML parsing
```

**Environment Variables:**
- `NODE_PATH=/usr/lib/node_modules` - Allows requiring globally installed npm packages in scripts

### Skill Architecture

This skill follows the **instruction-only pattern**:
- Tool does NOT execute operations itself
- Tool provides mandatory instructions with file paths and commands
- LLM executes each step using sandbox tools
- Enforces workflow compliance through emphatic language and warnings

---

## Quick Reference

**Tool Name**: `load_document_skill`

**Parameters**: `document_type` (required) - `"pptx"` | `"xlsx"` | `"docx"` | `"pdf"`

**Mandatory Workflow**:
1. Call `load_document_skill` to get instructions
2. **⚠️ NEVER SKIP**: Execute `sandbox_read_file` to read skill documentation (pre-installed in Docker)
3. Follow the loaded instructions to generate documents (DO NOT use 'claude' command or 'sandbox_claude' tool)
4. **⚠️ NEVER SKIP**: Execute `sandbox_upload_attachment` to upload document and return download URL

**Remember**:
- Always read the official skill documentation before generating documents. Your existing knowledge may be outdated.
- Always follow the design guidelines and best practices in the skill documentation.
- Always generate visually appealing, professional-looking documents with proper styling.
- Always upload documents and provide download URLs. Users cannot access sandbox files directly.
- DO NOT use 'claude' command or 'sandbox_claude' tool for document generation.
