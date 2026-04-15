---
description: "Upload DingTalk documents, spreadsheets, and AI tables to Wegent knowledge bases. Use this skill when the user wants to add DingTalk files to a knowledge base by providing DingTalk document URLs."
displayName: "钉钉文件上传到知识库"
version: "1.1.0"
author: "Wegent Team"
tags: ["dingtalk", "knowledge-base", "upload", "document", "spreadsheet"]
bindShells:
  - Chat
  - ClaudeCode
provider:
  module: provider
  class: DingtalkFileUploadProvider
tools:
  - name: get_dingtalk_mcp_config
    provider: dingtalk_file_upload
---

# DingTalk File Upload to Knowledge Base

This skill enables uploading DingTalk documents, spreadsheets, and AI tables to Wegent knowledge bases.

## When to Use

Use this skill when:
- User wants to add a DingTalk file to a knowledge base
- User provides a DingTalk document URL (e.g., `https://alidocs.dingtalk.com/i/nodes/...`)
- User mentions "adding to knowledge base" with DingTalk file references

## Available Tools

### get_dingtalk_mcp_config

Get current user's DingTalk MCP configuration for the specified service type.

**Parameters:**
- `service_type` (required): The DingTalk service type
  - `"docs"`: DingTalk Documents
  - `"table"`: DingTalk Spreadsheets
  - `"ai_table"`: DingTalk AI Tables

**Returns:**
Dictionary with MCP configuration for the requested service type:
```json
{
  "enabled": true,
  "url": "https://mcp.dingtalk.com/sse",
  "service_id": "docs",
  "server_name": "dingtalk_docs",
  "provider_id": "dingtalk"
}
```

**Usage Example:**
```json
{
  "name": "get_dingtalk_mcp_config",
  "arguments": {
    "service_type": "docs"
  }
}
```

**Note:** This tool accesses the current user's DingTalk MCP configuration from the database. If the service is not configured or not enabled, it will return `{"enabled": false}` with an error message.

## Workflow

When a user requests to upload a DingTalk file to a knowledge base, follow these steps:

### Step 1: Check DingTalk MCP Configuration

Before attempting to download DingTalk files, check if the required MCP service is configured:

1. **Get DingTalk MCP config**:
   - Use the `get_dingtalk_mcp_config` tool to check configuration
   - Specify the service type based on the file:
     - `"docs"` for DingTalk Documents
     - `"table"` for DingTalk Spreadsheets
     - `"ai_table"` for DingTalk AI Tables

2. **Verify configuration**:
   - If `enabled` is `false`, inform the user that the service is not configured
   - Provide guidance: "Please enable DingTalk MCP in your MCP settings"
   - If enabled, use the returned `url` and `server_name` for MCP operations

Example:
```json
{
  "name": "get_dingtalk_mcp_config",
  "arguments": {
    "service_type": "docs"
  }
}
```

### Step 2: Parse the Request

Extract the following from the user's request:
- DingTalk file URL (required): The URL of the DingTalk document/spreadsheet
- Target knowledge base (required): The knowledge base to upload to

The DingTalk URL format: `https://alidocs.dingtalk.com/i/nodes/{nodeId}`

Example user input:
```
将钉钉文档 https://alidocs.dingtalk.com/i/nodes/nYMoO1rWx23xv0mxSQN4qbNdJ47Z3je9 添加到当前知识库
```

### Step 3: Ensure Sandbox Environment

Load the `sandbox` skill first if not already loaded. The sandbox provides:
- File system for temporary storage
- Command execution for file operations
- Attachment upload capability

### Step 4: Download DingTalk File

Use the DingTalk MCP tools to download the file:

1. **Get document info** to determine file type:
   - Use `get_document_info` with the nodeId from the URL
   - This returns `contentType`, `extension`, and other metadata

2. **Download the file**:
   - For documents (ALIDOC type): Use `download_file` to get the file content
   - The download returns a URL and headers for fetching the file

3. **Save to sandbox**:
   - Use `exec` in sandbox to download the file using curl
   - Store temporarily (e.g., `/tmp/dingtalk_file.{extension}`)

### Step 5: Upload to Knowledge Base

Use the Wegent Knowledge skill tools:

1. **Determine upload method**:
   - For small files (<10MB): Use `create_document` with `source_type="file"` and base64-encoded content
   - For larger files: Upload as attachment first, then create document reference

2. **Create document**:
   ```
   create_document(
     knowledge_base_id=<target_kb_id>,
     name="<file_name>",
     source_type="file",
     file_base64="<base64_content>",
     file_extension="<extension>"
   )
   ```

### Step 6: Confirm Success

Report the upload result to the user with:
- File name uploaded
- Target knowledge base name
- Document ID for reference

## Tool Dependencies

This skill requires the following MCP servers to be available:

1. **DingTalk Docs MCP** (`dingtalk-docs`):
   - `get_document_info`: Get file metadata
   - `download_file`: Get download credentials

2. **DingTalk Table MCP** (`dingtalk-table`):
   - For spreadsheet operations if needed

3. **DingTalk AI Table MCP** (`dingtalk-ai-table`):
   - For AI table operations if needed

4. **Wegent Knowledge MCP** (`wegent-knowledge`):
   - `create_document`: Upload file to knowledge base
   - `list_knowledge_bases`: List available knowledge bases

5. **Sandbox Tools**:
   - `exec`: Execute download commands
   - `read_file`: Read downloaded file for base64 encoding
   - `upload_attachment`: Upload file as attachment if needed

## Error Handling

1. **Missing DingTalk MCP configuration**:
   - Inform user that DingTalk MCP is not configured
   - Provide instructions: "Please configure DingTalk MCP in your preferences"
   - Use `get_dingtalk_mcp_config` to check configuration before attempting file operations

2. **File not accessible**:
   - Check if user has permission to access the DingTalk file
   - Suggest: "Ensure you have access to this DingTalk document"

3. **Knowledge base not found**:
   - List available knowledge bases for user to choose
   - Or offer to create a new one

4. **File too large**:
   - If file exceeds limits, suggest:
     - Splitting into smaller parts
     - Uploading as attachment instead of document content

## Example Interaction

**User**: 将钉钉文档 https://alidocs.dingtalk.com/i/nodes/nYMoO1rWx23xv0mxSQN4qbNdJ47Z3je9 添加到当前知识库

**AI Response**:
1. Call `get_dingtalk_mcp_config(service_type="docs")` to verify configuration
2. Parse URL to extract nodeId: `nYMoO1rWx23xv0mxSQN4qbNdJ47Z3je9`
3. Call `get_document_info(nodeId)` to get file metadata
4. Call `download_file(nodeId)` to get download URL
5. Use sandbox `exec` to download file: `curl -o /tmp/file.xlsx "<download_url>"`
6. Read file and encode to base64
7. Call `create_document(knowledge_base_id=..., name="...", file_base64=..., file_extension="xlsx")`
8. Report success: "已成功将 'Document.xlsx' 上传到知识库 '我的知识库'"

## Notes

- This skill requires DingTalk MCP to be properly configured in user preferences
- Use `get_dingtalk_mcp_config` to verify configuration before attempting file operations
- The user must have access to the source DingTalk file
- The user must have write permission to the target knowledge base
- File size limits apply based on system configuration
