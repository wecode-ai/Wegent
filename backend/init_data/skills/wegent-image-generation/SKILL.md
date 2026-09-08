---
description: "Use this skill when the user asks to generate, draw, create, or revise an image. Supports text-to-image and image-reference generation."
displayName: "Image Generation"
version: "1.0.1"
author: "Wegent Team"
tags: ["image", "generation", "creative"]
bindShells: ["Chat", "Agno", "ClaudeCode"]
mcpServers:
  wegent-image:
    type: streamable-http
    url: "${{backend_url}}/mcp/image/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# Image Generation

Call `generate_image` when the user asks for an image.

- Put the complete visual description in `prompt`.
- Use `reference_images` only when the user supplied image attachments or URLs.
- Pass attachment IDs or public HTTP/HTTPS URLs, not local sandbox paths.
- For uploaded or previously generated images, pass attachment IDs. Do not pass Wegent
  attachment download URLs or relative `/api/attachments/...` paths as remote references.
- Default to one image unless the user explicitly asks for multiple images.
- The tool saves generated images as task attachments and returns image blocks. Do not create a duplicate card.
- If the tool returns `error`, explain it once and do not retry unchanged parameters.
