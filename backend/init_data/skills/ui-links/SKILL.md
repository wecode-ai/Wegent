---
description: "Use this skill when users ask to view, display, or open attachments (images, files), or need to navigate to Wegent pages. Supports attachment:// and wegent:// protocols for clickable links that the frontend renders as previews or navigation."
displayName: "UI Links"
version: "1.1.0"
author: "Wegent Team"
tags: ["ui", "links", "attachment", "scheme", "navigation"]
bindShells: ["Chat"]
---

# UI Links

This skill enables you to output special protocol links that the Wegent frontend renders as interactive elements. Use these links to display attachments or provide navigation to Wegent pages.

## When to Use

Use this skill when:

- User asks to "show", "view", "display", or "open" an attachment (image, file, etc.)
- User wants to navigate to a specific Wegent page (settings, chat, knowledge base, etc.)
- User needs quick actions like creating tasks, sending messages, or exporting data
- You need to provide clickable navigation within your response

**Important**: You do NOT need to call any tools. Simply output the markdown links directly in your response.

---

## Protocol Reference

### 1. Attachment Protocol (`attachment://`)

Display attachments (images, files) that exist in the conversation.

**Format:**
```markdown
![description](attachment://ID)
```

**Parameters:**
- `ID` (required): The numeric attachment ID (positive integer)

**Example:**
```markdown
![Project Screenshot](attachment://106)
```

**How it works:**
- The frontend automatically renders the attachment as a clickable preview
- For images: displays an inline preview that can be expanded
- For files: displays a file card with download option

---

### 2. Wegent Protocol (`wegent://`)

Navigate to Wegent pages or trigger actions.

**Format:**
```markdown
[link text](wegent://type/path?params)
```

**Structure:**
- `type`: Category of operation (`open`, `form`, `action`)
- `path`: Specific target within the type
- `params`: Optional query parameters

---

## Available Routes

### Navigation Routes (`wegent://open/*`)

Open Wegent pages directly.

| Route | Description | Parameters |
|-------|-------------|------------|
| `wegent://open/chat` | Open chat page | `team` (optional): Team ID |
| `wegent://open/code` | Open code page | `team` (optional): Team ID |
| `wegent://open/settings` | Open settings page | `tab` (optional): `integrations`, `bot`, `team`, `models` |
| `wegent://open/knowledge` | Open knowledge base | Path parameter for project ID |
| `wegent://open/feed` | Open activity feed | None |
| `wegent://open/feedback` | Open feedback dialog | None |

**Examples:**
```markdown
[Open Settings](wegent://open/settings)
[Configure Integrations](wegent://open/settings?tab=integrations)
[Go to Chat](wegent://open/chat?team=123)
[View Knowledge Base](wegent://open/knowledge/456)
```

---

### Form Routes (`wegent://form/*`)

Open dialogs to create resources.

| Route | Description | Parameters |
|-------|-------------|------------|
| `wegent://form/create-task` | Open create task dialog | `team` (optional): Pre-select team |
| `wegent://form/create-team` | Open create agent dialog | None |
| `wegent://form/create-bot` | Open create bot dialog | None |
| `wegent://form/add-repository` | Open add repository dialog | None |
| `wegent://form/create-subscription` | Open create subscription dialog | `data` (optional): JSON-encoded form data |

**Examples:**
```markdown
[Create New Task](wegent://form/create-task)
[Create Task for Team 123](wegent://form/create-task?team=123)
[Add New Agent](wegent://form/create-team)
[Add Repository](wegent://form/add-repository)
```

---

### Action Routes (`wegent://action/*`)

Trigger actions directly.

| Route | Description | Parameters |
|-------|-------------|------------|
| `wegent://action/send-message` | Send a message automatically | `text` (required), `team` (optional) |
| `wegent://action/prefill-message` | Prefill message input | `text` (required), `team` (optional) |
| `wegent://action/share` | Generate and copy share link | `type`, `id` (optional, uses current task) |
| `wegent://action/export-chat` | Export chat history | `taskId` (optional, uses current task) |
| `wegent://action/export-task` | Export task details | `taskId` (optional, uses current task) |
| `wegent://action/export-code` | Export code file | `taskId`, `fileId` (optional) |

**Examples:**
```markdown
[Send Hello](wegent://action/send-message?text=Hello)
[Try this prompt](wegent://action/prefill-message?text=Explain%20this%20code)
[Share Task](wegent://action/share)
[Export Chat](wegent://action/export-chat)
```

---

## Usage Examples

### Example 1: Display an Attachment

When user says "show me attachment 106":

```markdown
Here is the attachment you requested:

![Attachment 106](attachment://106)
```

### Example 2: Navigate to Settings

When user asks "how do I configure integrations":

```markdown
You can configure integrations in the settings page:

[Open Integrations Settings](wegent://open/settings?tab=integrations)
```

### Example 3: Help User Create a Task

When user wants to start a new task:

```markdown
Click below to create a new task:

[Create New Task](wegent://form/create-task)
```

### Example 4: Provide Quick Action

When user wants to try a specific prompt:

```markdown
Click to try this prompt:

[Explain this code](wegent://action/prefill-message?text=Please%20explain%20this%20code%20in%20detail)
```

### Example 5: Export Current Conversation

When user wants to save the chat:

```markdown
You can export this conversation:

[Export Chat History](wegent://action/export-chat)
```

---

## Best Practices

1. **Use descriptive link text**: Make it clear what clicking will do
   - Good: `[Open Settings Page](wegent://open/settings)`
   - Bad: `[Click here](wegent://open/settings)`

2. **URL-encode special characters**: Use `%20` for spaces in parameters
   - `wegent://action/prefill-message?text=Hello%20World`

3. **Provide context**: Explain what the link does before showing it

4. **Use appropriate protocol**:
   - `attachment://` for files/images
   - `wegent://open/*` for navigation
   - `wegent://form/*` for creating resources
   - `wegent://action/*` for triggering actions

---

## Troubleshooting

| Issue | Possible Cause | Solution |
|-------|----------------|----------|
| Link not rendering | Incorrect markdown format | Ensure format is `[text](url)` or `![alt](url)` |
| Attachment not found | Invalid attachment ID | Verify the ID exists in the conversation |
| Action not working | Missing required parameter | Check that required params like `text` are provided |
| Navigation fails | Invalid route | Verify the route exists in the reference above |
| Special characters breaking URL | Not URL-encoded | Encode spaces as `%20`, etc. |
