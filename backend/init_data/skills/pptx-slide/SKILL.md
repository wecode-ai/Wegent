# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

---
description: "Use this skill when you need to create PowerPoint presentations (PPTX files). Generates professional slides from text outlines, descriptions, or templates using python-pptx library in a secure E2B sandbox environment."
displayName: "Generate PPT"
version: "1.0.0"
author: "Wegent Team"
tags: ["pptx", "presentation", "office", "document", "slides"]
bindShells: ["Chat"]
provider:
  module: provider
  class: PPTXToolProvider
tools:
  - name: create_pptx
    provider: pptx
    config:
      timeout: 120
      max_retries: 3
---

# PowerPoint Presentation Generator

This skill enables you to create professional PowerPoint presentations (PPTX files) using Python code executed in a secure E2B sandbox environment.

## Tool: create_pptx

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The PPT content description or outline. Can be structured text with titles, bullet points, and sections. |
| `title` | string | No | The main title of the presentation (used for the title slide and filename). |
| `template` | string | No | Template style to use: "default", "professional", "minimal", or custom Python code for advanced templates. |
| `filename` | string | No | Output filename (default: "presentation.pptx"). |

### Content Format Guidelines

For best results, structure your content as follows:

```
Title Slide: [Main Title]
Subtitle: [Optional subtitle]

Slide 1: [Slide Title]
- Bullet point 1
- Bullet point 2
- Bullet point 3

Slide 2: [Slide Title]
- Content item 1
- Content item 2
  - Sub-item

...
```

### Example Usage

#### Basic Presentation

```json
{
  "name": "create_pptx",
  "arguments": {
    "content": "Title Slide: Q4 2024 Report\nSubtitle: Sales Performance Summary\n\nSlide 1: Overview\n- Total revenue: $2.5M\n- Growth: 15% YoY\n- New customers: 150\n\nSlide 2: Key Achievements\n- Launched new product line\n- Expanded to 3 new markets\n- Customer satisfaction: 95%",
    "title": "Q4 2024 Report"
  }
}
```

#### Professional Template

```json
{
  "name": "create_pptx",
  "arguments": {
    "content": "Title Slide: Project Proposal\nSubtitle: Digital Transformation Initiative\n\nSlide 1: Executive Summary\n- Modernize legacy systems\n- Improve efficiency by 40%\n- ROI within 18 months\n\nSlide 2: Timeline\n- Phase 1: Assessment (Q1)\n- Phase 2: Development (Q2-Q3)\n- Phase 3: Deployment (Q4)",
    "title": "Project Proposal",
    "template": "professional"
  }
}
```

### Return Value

The tool returns a JSON response:

**On Success:**
```json
{
  "success": true,
  "attachment_id": 123,
  "filename": "presentation.pptx",
  "download_url": "/api/v1/attachments/123/download",
  "slide_count": 5,
  "message": "PowerPoint presentation created successfully..."
}
```

**On Failure (with retries exhausted):**
```json
{
  "success": false,
  "error": "Failed to generate presentation after 3 attempts",
  "final_instruction": "CRITICAL: All automatic generation attempts have failed...",
  "last_error": "Detailed error message"
}
```

## Template Styles

### default
Clean, simple layout with blue accent colors. Good for general presentations.

### professional
Corporate-style with navy blue theme, suitable for business presentations.

### minimal
Clean white background with minimal design elements, ideal for content-focused slides.

## Best Practices

1. **Clear Structure**: Use clear headings and bullet points for better slide organization
2. **Concise Content**: Keep bullet points short and meaningful
3. **Logical Flow**: Organize slides in a logical sequence
4. **Consistent Style**: Stick to one template style throughout

## Error Handling

The tool includes automatic retry with error correction:

1. **First Attempt**: Generates PPT based on provided content
2. **On Failure**: Analyzes error, adjusts code, and retries
3. **Up to 3 Retries**: Automatically attempts to fix generation errors
4. **Final Failure**: Returns detailed error information for manual resolution

## Important Notes

1. **File Download**: After successful generation, the PPT file is stored as an attachment and can be downloaded via the provided URL
2. **Sandbox Execution**: All Python code runs in an isolated E2B sandbox for security
3. **Timeout**: Default timeout is 120 seconds; complex presentations may need more time
4. **File Size**: Generated files are stored in the attachment system and linked to the conversation
