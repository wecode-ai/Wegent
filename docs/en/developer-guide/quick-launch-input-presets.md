---
sidebar_position: 28
---

# QuickCard Input Presets

## Overview

QuickCard system functions are input prefill entries. A system function targets an agent and owns one or more input presets. When a user clicks a system function, the UI selects the target agent and shows the preset list on the current page or the target page.

Input presets do not send messages directly. They only update the input draft and input controls. ChatInput remains the single place that sends the final message.

## Data Model

System functions are still stored under the `quick_launch_functions` system config key. Each function uses `input_presets` to describe presets that can be applied to the input:

```json
{
  "id": "code_review",
  "title": "Code Review",
  "team_id": 7,
  "enabled": true,
  "order": 10,
  "input_presets": [
    {
      "id": "review_change",
      "title": "Review Change",
      "prompt": "Please review the current code change",
      "options": {
        "enable_deep_thinking": false,
        "enable_clarification": true,
        "force_override": true,
        "selected_skill_names": ["code-review"]
      }
    }
  ]
}
```

Legacy `quick_phrases` config is migrated to input presets when read. Saves emit `input_presets`.

## Launch Flow

Cross-page launches use a one-time launch intent in the URL:

- `teamId`: target agent ID
- `quickLauncher`: system function or favorite agent key
- `quickPreset`: optional preset ID to apply directly
- `showPresets=1`: show the current function's preset list after entering the target page

The target page clears these query parameters after reading the intent. After cleanup, the URL no longer continuously controls agent selection, so the user can clear or switch the selected agent.

## Supported Input Options

Input presets currently support these stable, serializable input options:

- `prompt`: input text
- `enable_deep_thinking`: deep thinking toggle
- `enable_clarification`: clarification toggle
- `force_override`: force model override toggle
- `selected_skill_names`: skill names preselected for this input

Attachments, repositories, branches, and user contexts are intentionally excluded from system function configuration. They depend on the user's environment, permissions, or current task state, so they are not suitable as global system presets.
