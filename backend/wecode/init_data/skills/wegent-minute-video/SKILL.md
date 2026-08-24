---
description: "Plan and produce a one-minute creative video through the private QIA stepped workflow."
displayName: "One-minute Creative Video"
version: "2.0.0"
author: "Wegent Team"
tags: ["video", "minute-video", "creative", "qia"]
bindShells: ["Chat"]
config:
  inject_generation_context: true
provider:
  module: provider
  class: MinuteVideoProvider
tools:
  - name: analyze_video_material
    provider: wegent-minute-video
  - name: save_draft_script
    provider: wegent-minute-video
  - name: create_script_by_draft
    provider: wegent-minute-video
  - name: generate_storyboard_videos
    provider: wegent-minute-video
  - name: generate_final_video
    provider: wegent-minute-video
mcpServers:
  wegent-cards:
    type: streamable-http
    url: "${{backend_url}}/mcp/cards/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 60
  wegent-interactive-form-question:
    type: streamable-http
    url: "${{backend_url}}/mcp/interactive-form-question/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# One-minute Creative Video

Use this Skill for the dedicated one-minute creative-video Agent. The user-selected
video model, model parameters, current materials, current prompt, and relevant
history are injected into the Skill tools automatically.

## Non-negotiable rules

- The total film duration is fixed at 60 seconds.
- The Bot primary model is the selected video model. The Bot secondary model drives
  this conversation and calls these tools.
- Never call `generate_video`; generation context is injected into this Skill.
- Never invent model names, model parameters, attachment IDs, QIA task IDs, or URLs.
- QIA owns planning records, generation workflow, and its private detail page.
- Wegent only creates and updates `video_director_generation` CardBlocks.
- After any workflow tool succeeds, copy the returned `mcp_card.task_url`,
  `preview_title`, `progress_text`, and `card_type` into
  `create_async_video_card`. Call it exactly once for that workflow task.
- If a workflow tool returns `success: false`, report the error and do not create a
  card.
- A `pending` result from `create_async_video_card` is final for the current turn.
  Do not create another card.

## New video workflow

1. Understand the user's idea and uploaded materials.
2. Call `analyze_video_material` before writing when video material is present.
   Incorporate its description into the script. If it fails, stop and report the
   error.
3. If essential creative preferences are genuinely missing, call
   `interactive_form_question` once with only the missing items selected from:
   subtitles, narration, background music, visual style, emotional tone, and
   optional notes. Never ask for duration, video model, resolution, ratio, or
   generation mode. Stop immediately after rendering the form.
4. Write a complete 60-second Markdown script. Include:
   - title and one-sentence concept;
   - audience, style, mood, subtitles, narration, and music;
   - ordered shots with time ranges totaling exactly 60 seconds;
   - for each shot: visual subject, scene, action, framing, camera movement,
     narration/dialogue, subtitle, sound, and transition;
   - a concise list of reusable characters, scenes, and props.
5. Call `save_draft_script` with the complete Markdown. Do not put video model or
   technical parameters into `user_requirement`; they are already injected.
6. Create the returned asynchronous card and end the turn.

## Follow-up workflow

Use the current Wegent task as the workflow identity:

- “生成主体” or equivalent: call `create_script_by_draft`, then create its card.
- “生成分镜视频” or equivalent: call `generate_storyboard_videos`, then create its
  card.
- “生成视频”, “合成视频”, or equivalent: call `generate_final_video`, then create
  its card.

Do not reconstruct QIA URLs. Only use the HTTP(S) URL returned in `mcp_card`.
