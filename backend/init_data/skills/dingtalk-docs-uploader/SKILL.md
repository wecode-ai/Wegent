---
name: dingtalk-docs-uploader
description: "Upload DingTalk documents, spreadsheets, and AI tables to Wegent knowledge base. Use when user wants to import DingTalk files (documents, spreadsheets, AI tables) into the current knowledge base by providing a DingTalk URL. Triggers when user mentions adding DingTalk files to knowledge base or importing from DingTalk URLs like https://alidocs.dingtalk.com/i/nodes/xxx. Supports DingTalk online documents, spreadsheets (axls), and AI tables (able)."
---

# DingTalk Documents Uploader

Upload DingTalk documents, spreadsheets, and AI tables to Wegent knowledge base.

## Overview

This skill enables importing files from DingTalk (documents, spreadsheets, AI tables) into Wegent knowledge bases. It handles:

1. Extracting DingTalk document metadata
2. Downloading document content
3. Converting to appropriate format
4. Uploading as attachment to knowledge base

## Supported File Types

| DingTalk Type | Extension | Description |
|--------------|-----------|-------------|
| Online Document | `.adoc` | DingTalk online documents |
| Spreadsheet | `.axls` | DingTalk online spreadsheets |
| AI Table | `.able` | DingTalk AI tables (multidimensional) |

## Workflow

When user wants to add a DingTalk file to knowledge base:

1. **Parse the DingTalk URL** to extract `nodeId` (document ID)
2. **Get document info** using `get_document_info` to check type and metadata
3. **Download content** based on document type:
   - For documents: use `get_document_content` to get Markdown content
   - For spreadsheets: use `get_range` to get all sheet data
   - For AI tables: use `query_records` to get all records
4. **Save to sandbox** as a file
5. **Upload to knowledge base** using `upload_attachment` tool

## Tool Usage

### Step 1: Get Document Info

```json
{
  "name": "get_document_info",
  "arguments": {
    "nodeId": "https://alidocs.dingtalk.com/i/nodes/xxxxx"
  }
}
```

Returns:
- `contentType`: Document type (ALIDOC, etc.)
- `extension`: File extension (adoc, axls, able)
- `name`: Document name

### Step 2: Get Document Content

For online documents (adoc):
```json
{
  "name": "get_document_content",
  "arguments": {
    "nodeId": "https://alidocs.dingtalk.com/i/nodes/xxxxx"
  }
}
```

For spreadsheets (axls):
```json
{
  "name": "get_all_sheets",
  "arguments": {
    "nodeId": "https://alidocs.dingtalk.com/i/nodes/xxxxx"
  }
}
```
Then:
```json
{
  "name": "get_range",
  "arguments": {
    "nodeId": "https://alidocs.dingtalk.com/i/nodes/xxxxx",
    "sheetId": "sheet-id-from-get_all_sheets"
  }
}
```

For AI tables (able):
```json
{
  "name": "get_tables",
  "arguments": {
    "nodeId": "https://alidocs.dingtalk.com/i/nodes/xxxxx"
  }
}
```
Then:
```json
{
  "name": "query_records",
  "arguments": {
    "nodeId": "https://alidocs.dingtalk.com/i/nodes/xxxxx",
    "tableId": "table-id-from-get_tables"
  }
}
```

### Step 3: Save and Upload

Use `write_file` to save content to sandbox, then `upload_attachment` to upload to knowledge base.

## Example User Requests

- "将钉钉文档 https://alidocs.dingtalk.com/i/nodes/xxx 添加到当前知识库"
- "Upload this DingTalk spreadsheet to the knowledge base: https://alidocs.dingtalk.com/i/nodes/yyy"
- "Import the DingTalk AI table into my knowledge base"

## Error Handling

- If document is not accessible, inform user to check permissions
- If document type is unsupported, explain supported types
- If upload fails, retry once or report specific error
