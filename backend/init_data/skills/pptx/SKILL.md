---
description: "Use this skill when you need to generate PowerPoint presentations (PPTX files) from content. The skill can create professional presentations with titles, bullet points, multiple slides, and various themes. Use this when users ask for slides, decks, presentations, or PPTX files."
displayName: "Generate PPTX"
version: "1.0.0"
author: "Wegent Team"
tags: ["presentation", "pptx", "powerpoint", "slides"]
bindShells: ["Chat"]
provider:
  module: provider
  class: PPTXToolProvider
tools:
  - name: generate_pptx
    provider: pptx
    config:
      max_slides: 50
      timeout: 120
dependencies:
  - python-pptx
---

# PowerPoint Presentation Generator

Use this skill to create professional PowerPoint presentations from structured content.

## Tool: generate_pptx

Generate a PPTX file from structured slide data.

### Parameters

| Parameter | Type   | Required | Description                                                        |
| --------- | ------ | -------- | ------------------------------------------------------------------ |
| `title`   | string | Yes      | The presentation title (appears on title slide)                    |
| `slides`  | array  | Yes      | Array of slide objects                                             |
| `author`  | string | No       | Author name (appears on title slide)                               |
| `theme`   | string | No       | Color theme: 'default', 'professional', 'creative', 'minimal'      |

### Slide Object Structure

Each slide in the `slides` array should have:

| Field     | Type   | Required | Description                                                    |
| --------- | ------ | -------- | -------------------------------------------------------------- |
| `title`   | string | Yes      | Slide title                                                    |
| `content` | string | Yes      | Slide content in markdown format (bullet points with - or *)   |
| `notes`   | string | No       | Speaker notes for this slide                                   |
| `layout`  | string | No       | Layout type: 'title', 'title_and_content', 'two_column', 'blank' |

### Example Tool Call

```json
{
  "name": "generate_pptx",
  "arguments": {
    "title": "Q4 Business Review",
    "author": "John Smith",
    "theme": "professional",
    "slides": [
      {
        "title": "Executive Summary",
        "content": "- Revenue increased by 25%\n- Customer satisfaction at 92%\n- New market expansion successful",
        "notes": "Highlight the key achievements first"
      },
      {
        "title": "Financial Performance",
        "content": "- Total Revenue: $10M\n  - Product Sales: $7M\n  - Services: $3M\n- Operating Margin: 18%\n- Cash Flow: Positive",
        "layout": "title_and_content"
      },
      {
        "title": "Next Steps",
        "content": "- Launch new product line in Q1\n- Expand to 3 new regions\n- Increase marketing budget by 15%"
      }
    ]
  }
}
```

### Response Format

On success, the tool returns a JSON response with:

```json
{
  "status": "success",
  "message": "Generated presentation 'Q4 Business Review' with 4 slides",
  "pptx_context_id": 123,
  "filename": "Q4_Business_Review.pptx",
  "slide_count": 4,
  "file_size": 45678,
  "download_url": "/api/attachments/123/download"
}
```

## Best Practices

### Content Structure

1. **Keep slides focused**: Each slide should cover one main topic
2. **Use bullet points**: Format content with `-` or `*` for bullet points
3. **Nested bullets**: Use indentation (2 spaces + bullet) for sub-points
4. **Limit text**: Keep to 5-7 bullet points per slide maximum

### Example Content Formatting

```markdown
- Main point 1
- Main point 2
  - Sub-point 2.1
  - Sub-point 2.2
- Main point 3
```

### Theme Selection

- **default**: Classic blue theme, suitable for most presentations
- **professional**: Dark slate colors, corporate style
- **creative**: Bold red/orange accents, dynamic feel
- **minimal**: Grayscale, clean and modern

### Workflow

1. **Understand the requirement**: Clarify what content the user wants
2. **Structure the content**: Organize into logical slides
3. **Generate the PPTX**: Call the tool with structured data
4. **Provide download link**: Share the download URL with the user

### Error Handling

If the tool returns an error:
- Check that the title is not empty
- Ensure at least one slide is provided
- Verify slide content is properly formatted

## Common Use Cases

1. **Business presentations**: Quarterly reviews, project updates
2. **Educational content**: Lecture slides, training materials
3. **Proposals**: Project pitches, sales decks
4. **Reports**: Data summaries, analysis presentations
