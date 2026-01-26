# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Binary Attachment Prompt Builder.

This module provides functions to build system prompt sections for binary
attachments that require sandbox download for analysis. Binary attachments
(Excel, PDF, archives, etc.) cannot be fully analyzed by text extraction
alone and need to be downloaded to the sandbox for processing with
appropriate tools (pandas, openpyxl, etc.).
"""


def build_binary_attachment_prompt(binary_attachments: list[dict]) -> str:
    """
    Build system prompt section for binary attachments available for sandbox download.

    When binary attachments are present, this generates a prompt section that:
    1. Lists all available attachments with their download URLs
    2. Provides instructions for downloading and processing the files
    3. Shows example workflows for common file types (Excel analysis, etc.)

    Args:
        binary_attachments: List of binary attachment metadata dicts.
            Each dict contains:
            - id: Attachment ID
            - filename: Original filename
            - mime_type: MIME type
            - download_url: API endpoint for downloading (e.g., /api/attachments/123/download)
            - file_extension: File extension (e.g., .xlsx)

    Returns:
        Formatted prompt string for binary attachments, or empty string if none.
    """
    if not binary_attachments:
        return ""

    attachments_info = []
    for att in binary_attachments:
        att_id = att.get("id", "unknown")
        filename = att.get("filename", "unknown")
        mime_type = att.get("mime_type", "application/octet-stream")
        download_url = att.get("download_url", f"/api/attachments/{att_id}/download")

        attachments_info.append(
            f"- **{filename}** (ID: {att_id}, Type: {mime_type})\n"
            f"  Download URL: `{download_url}`"
        )

    attachments_list = "\n".join(attachments_info)

    return f"""

## Available Attachments for Processing

The user has uploaded the following file(s) that can be downloaded to the sandbox for analysis:

{attachments_list}

### How to Process These Attachments

1. **Load the sandbox skill** if not already loaded: Call `load_skill` with `skill_name: "sandbox"`
2. **Download the attachment** using `sandbox_download_attachment`:
   - `attachment_url`: Use the download URL shown above (e.g., `/api/attachments/123/download`)
   - `save_path`: Choose a path like `/home/user/downloads/<filename>`
3. **Process the file** using appropriate sandbox tools (e.g., `sandbox_command` to run Python/pandas for Excel analysis)

### Example Workflow for Excel Analysis

```json
// Step 1: Download the file
{{
  "name": "sandbox_download_attachment",
  "arguments": {{
    "attachment_url": "/api/attachments/123/download",
    "save_path": "/home/user/downloads/data.xlsx"
  }}
}}

// Step 2: Analyze with Python
{{
  "name": "sandbox_command",
  "arguments": {{
    "command": "python -c \\"import pandas as pd; df = pd.read_excel('/home/user/downloads/data.xlsx'); print(df.describe())\\""
  }}
}}
```

### Example Workflow for CSV Analysis

```json
// Step 1: Download the file
{{
  "name": "sandbox_download_attachment",
  "arguments": {{
    "attachment_url": "/api/attachments/456/download",
    "save_path": "/home/user/downloads/data.csv"
  }}
}}

// Step 2: Analyze with Python
{{
  "name": "sandbox_command",
  "arguments": {{
    "command": "python -c \\"import pandas as pd; df = pd.read_csv('/home/user/downloads/data.csv'); print(df.head()); print(df.describe())\\""
  }}
}}
```

### Example Workflow for PDF Analysis

```json
// Step 1: Download the file
{{
  "name": "sandbox_download_attachment",
  "arguments": {{
    "attachment_url": "/api/attachments/789/download",
    "save_path": "/home/user/downloads/document.pdf"
  }}
}}

// Step 2: Extract text with Python
{{
  "name": "sandbox_command",
  "arguments": {{
    "command": "python -c \\"import PyPDF2; reader = PyPDF2.PdfReader('/home/user/downloads/document.pdf'); print([page.extract_text() for page in reader.pages])\\""
  }}
}}
```

**Note:** Always download the attachment first before attempting to analyze it. The sandbox environment has the necessary tools (pandas, openpyxl, PyPDF2, etc.) pre-installed.
"""


def append_binary_attachment_prompt(
    system_prompt: str,
    binary_attachments: list[dict] | None,
) -> str:
    """
    Append binary attachment prompt to system prompt if attachments are present.

    Args:
        system_prompt: The original system prompt.
        binary_attachments: List of binary attachment metadata dicts, or None.

    Returns:
        The system prompt with binary attachment instructions appended if present.
    """
    if not binary_attachments:
        return system_prompt

    attachment_prompt = build_binary_attachment_prompt(binary_attachments)
    if attachment_prompt:
        return system_prompt + attachment_prompt

    return system_prompt
