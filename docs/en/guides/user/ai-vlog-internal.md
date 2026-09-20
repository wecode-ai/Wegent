---
sidebar_position: 90
---

# Internal AI Vlog Editing

AI Vlog Editing uses AIGC's existing three-style pipeline. Each result can be
opened in OpenCut, saved, and rendered independently. Existing editing and
highlight agents are unchanged.

## Configuration

Install `skills/material-to-video-multi-style` from the AIGC repository. Create a
separate Ghost using its system prompt, bind and preload the Skill, then create a
Bot with the Chat Shell and an image/tool-capable model. Create a separate Team
with `requiresWorkspace=false`. Replace promises of Weibo private-message
notifications with instructions to check the result card when unavailable.

Backend and Chat Shell must use the same `AIGC_VIDEO_AGENT_URL`. Background
pollers must be able to access `WEGENT_BACKEND_PUBLIC_URL`. Use
`DEPLOYMENT_MODE=internal` only for the internal AIGC instance. Verify its
`mv_style_task` and pipeline tables, templates, and Workers.

If the frontend proxy rejects cross-origin callbacks, set Backend's
`OPENCUT_CALLBACK_URL` to its browser-accessible URL. The backend still verifies
signed requests; no public proxy security rule needs to change. Leaving it empty
retains the existing callback address.

## Behavior and isolation

The private `create_async_multi_video_card` tool reuses public durable polling
through a signed private adapter endpoint. The task token determines the user
and parent task; callers cannot select a different identity through the URL.
Each variant retains its own progress, failure state, and playable result.

OpenCut opens only after a click. Shared cards are read-only. Saving and rendering
sends a chat instruction containing the selected child session, such as `137_2`,
to `rerender_style_video`. It must not regenerate the other variants. This uses
the internal chat callback instead of external private card-button metadata.

Validate image, video, and mixed inputs, incremental completion, partial failure,
refresh recovery, per-variant editing, and cross-user/task rejection. Start with
short inputs because three parallel variants consume generation resources.
