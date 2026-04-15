# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

name: dingtalk-connector
description: |
  Skill for adding DingTalk documents to Wegent knowledge bases.

  This skill provides tools to:
  1. Download DingTalk documents via MCP
  2. Save documents with name: {title}.{file_extension}
  3. Upload as attachments to Wegent
  4. Create knowledge base documents

  Usage:
  - Use `dingtalk_doc_to_kb` tool to add a DingTalk document to a knowledge base
  - The tool handles the entire workflow: download -> save -> upload -> create document

version: 1.0.0
author: Wegent Team

mcp_servers:
  wegent-knowledge:
    type: streamable-http
    url: "${backend_url}/mcp/knowledge/sse"
    headers:
      Authorization: "Bearer ${auth_token}"
    timeout: 300

tools:
  - name: dingtalk_doc_to_kb
    provider: dingtalk-connector
    description: |
      Add a DingTalk document to Wegent knowledge base.

      This tool performs the complete workflow:
      1. Starts a sandbox environment
      2. Downloads the DingTalk document content via MCP
      3. Saves the document as {title}.{file_extension}
      4. Uploads the file as an attachment
      5. Creates a knowledge base document

      Parameters:
      - dingtalk_doc_url: The DingTalk document URL
      - knowledge_base_id: Target knowledge base ID
      - doc_title: Document title (optional, fetched from DingTalk if not provided)

      Returns:
      - success: Whether the operation succeeded
      - document_id: Created document ID
      - document_name: Document name
      - attachment_id: Attachment ID
      - message: Status message
