---
description: "Use this skill when the user asks to generate or create a video. Supports text, image, video, and audio reference materials according to the selected video model."
displayName: "Video Generation"
version: "1.0.0"
author: "Wegent Team"
tags: ["video", "generation", "creative"]
bindShells: ["Chat", "Agno", "ClaudeCode"]
mcpServers:
  wegent-video:
    type: streamable-http
    url: "${{backend_url}}/mcp/video/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 60
---

# Video Generation

Call `generate_video` when the user asks for a video.

- Put the complete scene, motion, camera, and style requirements in `prompt`.
- Pass reference material attachment IDs or HTTP URLs; never pass sandbox paths.
- Only pass materials provided or selected by the user.
- A `polling` response means the request was accepted. The system creates and updates the video block asynchronously.
- Do not call the tool again after a `polling` response and do not create a duplicate card.
- If the tool returns `error`, explain it once and retry only after changing invalid parameters.
