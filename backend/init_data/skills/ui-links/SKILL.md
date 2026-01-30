---
description: "Provide UI link helpers for attachment:// and wegent:// so models can return clickable UI links."
displayName: "UI 链接"
version: "1.0.0"
author: "Wegent Team"
tags: ["ui", "links", "attachment", "scheme"]
bindShells: ["Chat"]
provider:
  module: provider
  class: UiLinksToolProvider
tools:
  - name: ui_attachment_link
    provider: ui-links
    config:
      api_base_url: ""
  - name: ui_wegent_link
    provider: ui-links
---

# UI Links Skill

Generate UI-ready Markdown links for the frontend to render:

## Tools

### ui_attachment_link
Return `![Attachment](attachment://{id})` for an attachment ID. The tool validates
that the attachment exists and is accessible to the current user.

**Parameters**
- `attachment_id` (required): Attachment ID
- `alt_text` (optional): Alt text used in the Markdown image link

**Example**
```json
{"attachment_id": 123, "alt_text": "Attachment"}
```

### ui_wegent_link
Return `[Open](wegent://...)` for a Wegent scheme URL.

**Parameters**
- `scheme_url` (required): Wegent scheme URL, e.g. `wegent://open/chat`
- `label` (optional): Link label

**Example**
```json
{"scheme_url": "wegent://open/chat", "label": "Open"}
```
