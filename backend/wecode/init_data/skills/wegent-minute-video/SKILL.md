---
description: "Create a one-minute creative video through QIA using the video model selected in Wegent."
displayName: "One-minute Creative Video"
version: "1.0.0"
author: "Wegent Team"
tags: ["video", "minute-video", "creative", "qia"]
bindShells: ["Chat"]
mcpServers:
  wegent-video:
    type: streamable-http
    url: "${{backend_url}}/mcp/video/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 60
---

# One-minute Creative Video

Use `create_minute_video` when the user asks to create a one-minute creative video.

- Turn the request into one complete creative brief covering story, visual style,
  subjects, scenes, camera language, pacing, music, and subtitles.
- Pass user-provided image and video attachment IDs in `reference_images` and
  `reference_videos`. Never invent attachments or pass local file paths.
- Do not ask the user for a video model. The tool reads the model selected in Wegent.
- A `polling` response means the workflow was accepted. Do not call the tool again or
  create another card.
- QIA owns the private detail and editing page. The Wegent card only displays progress
  and opens the HTTP(S) link returned by QIA.
- If the tool returns `error`, explain the error once. Retry only after its cause has
  changed.
