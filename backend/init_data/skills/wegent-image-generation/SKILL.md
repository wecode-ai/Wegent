---
description: "当用户需要生成或修改图片时使用，例如制作海报、商品图、社交媒体配图、插画、信息图，或参考一张或多张已有图片进行改图和创作。"
displayName: "图片生成"
version: "1.3.2"
author: "Wegent Team"
tags: ["image", "generation", "creative"]
bindShells: ["Chat", "ClaudeCode"]
mcpServers:
  wegent-image:
    type: streamable-http
    url: "${{backend_url}}/mcp/image/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# Image Generation

Call `generate_image` as soon as the user's intent is clear. Do not ask for confirmation
or repeat the request before generating.

## Determine the intent

- Treat a request with no input image as new image generation.
- Treat input images used for subject, style, composition, or mood as references, not as
  edit targets.
- Treat a request that changes part of an existing image while preserving the rest as an
  edit.
- Label every input image by order and role in `prompt`, such as `Image 1: edit target`
  and `Image 2: style reference`. For compositing, say exactly what comes from each image.

## Build the prompt

- Turn the request into a concise, self-contained visual specification. If the user is
  already specific, normalize their request without adding creative requirements. If the
  request is generic, add only details that materially improve the result.
- Include the intended use when known, such as a hero banner, product shot, poster,
  infographic, sprite, or concept art; it determines composition and polish.
- For complex requests, use only the relevant lines from this order inside `prompt`:
  `Canvas/layout`, `Purpose`, `Primary request`, `Input images`, `Scene`, `Subject`,
  `Style/medium`, `Composition`, `Lighting/color`, `Text`, `Constraints`, `Avoid`.
- For posters, UI, infographics, diagrams, and educational visuals, define the canvas,
  fixed regions, information hierarchy, exact labels or data, and annotation behavior
  before describing surface detail. Use JSON-like structure only when it makes a dense
  layout clearer.
- For grids, storyboards, character sheets, or other multi-panel images, specify the exact
  rows, columns, or panel count; give every panel a role; and require consistent identity,
  proportions, art direction, palette, and lighting across panels.
- Prefer concrete visual direction over keyword lists. Use camera, framing, and real-world
  texture details only when appropriate to the requested style. For photorealism, choose
  one coherent capture context and include ordinary materials or imperfections instead of
  vague quality adjectives or conflicting camera specifications.
- For edits, explicitly say `change only X; keep Y unchanged`. Restate all invariants on
  every edit call. For compositing, require consistent lighting, perspective, scale, and
  shadows.
- Put required visible text in quotes, require verbatim spelling with no extra characters,
  and specify typography and placement when known. Spell uncommon words letter by letter
  when accuracy matters. For multilingual layouts, state the required language or script
  and prohibit unwanted translation, transliteration, or garbled characters.
- Do not invent extra characters, objects, text, logos, brand details, palettes, or story
  elements that are not stated or implied by the request.
- Keep `Avoid` short and targeted to likely failure modes; do not overwhelm the prompt
  with generic negative instructions.
- Resolve minor omissions with sensible visual choices. Ask a question only when a
  missing detail would materially change the result.

## Set tool arguments

- Use `reference_images` only for images the user supplied or explicitly selected,
  including an image generated earlier in the conversation.
- Pass attachment IDs, public HTTP/HTTPS URLs, or base64 data URLs. Never pass local
  sandbox paths.
- For uploaded or previously generated images, pass attachment IDs. Do not pass Wegent
  attachment download URLs or relative `/api/attachments/...` paths as remote references.
- Preserve the user's reference-image order and pass every image needed for the request.
- Use `max_images` for multiple variants or a coherent series from one prompt. Use separate
  calls with tailored prompts for distinct unrelated assets. Otherwise default to `1`.
  The supported range per call is `1` to `15`; explain the limit before calling if the
  request exceeds it.
- Set `size` only when the user provides an exact `WIDTHxHEIGHT` value. Otherwise omit it
  and express orientation or aspect-ratio preferences in `prompt`.

## Handle the result

- The tool saves generated images as task attachments and returns image blocks. Do not
  create another image card or duplicate the returned images.
- On success, respond briefly and do not repeat the full prompt unless asked.
- If the tool returns `error`, explain it once. Retry only after correcting invalid
  arguments or after the user changes the request; never retry unchanged parameters.
