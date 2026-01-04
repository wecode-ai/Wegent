# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

---
description: "Intelligent Meeting Booking Assistant - Identifies meeting requirements, fetches available resources, and generates interactive booking forms"
displayName: "Meeting Booking"
version: "1.0.0"
author: "Wegent Team"
tags: ["meeting", "booking", "calendar", "scheduling"]
bindShells: ["Chat"]
provider:
  module: provider
  class: MeetingBookingToolProvider
tools:
  - name: get_meeting_resources
    provider: meeting-booking
    config:
      timeout: 30
dependencies:
  - app.chat_shell.tools.pending_requests
---

# Meeting Booking Skill

When users express meeting-related requests (such as "schedule a meeting", "book a meeting room", "arrange a meeting"), use this Skill to help them complete the meeting booking process.

## Usage Flow

1. First, call `get_meeting_resources` tool to fetch available meeting rooms and potential participants
2. Based on user requirements and available resources, generate a meeting booking form (using the specified Markdown format below)
3. Wait for user to confirm the form - the frontend will automatically call the remote booking service
4. After receiving the booking result, provide feedback to the user

## Natural Language Time Parsing

Support parsing the following time expressions:

- "3pm" / "15:00" → 15:00
- "tomorrow at 10am" → Next day 10:00
- "day after tomorrow at 2:30pm" → Day after tomorrow 14:30
- "tonight at 8pm" → 20:00
- "30 minutes" / "1 hour" / "1.5 hours" → Meeting duration
- "下午3点" / "下午15点" → 15:00
- "明天上午10点" → Next day 10:00
- "后天下午2点半" → Day after tomorrow 14:30

## Meeting Booking Form Format

**IMPORTANT**: You MUST strictly follow this Markdown format for the form. The frontend relies on this exact format for parsing and rendering.

```markdown
## 📅 会议预约确认 (Meeting Booking Confirmation)

### 会议名称 (Meeting Title)
**Type**: text_input
**Value**: `{Auto-filled meeting title based on user description}`

### 会议时间 (Meeting Time)
**Type**: datetime_range
**Start**: `{Start time in ISO format, e.g., 2025-01-05T15:00:00}`
**End**: `{End time in ISO format, e.g., 2025-01-05T15:30:00}`
**Duration**: `{Duration in minutes, e.g., 30}`

### 会议地点 (Meeting Location)
**Type**: single_choice
**Options**:
- [✓] `{room_id}` - {Room Name} (Recommended)
- [ ] `{room_id}` - {Room Name}
...

### 参会人员 (Participants)
**Type**: multiple_choice
**Options**:
- [✓] `{user_id}` - {User Name} (Recommended)
- [ ] `{user_id}` - {User Name}
...
```

## Important Notes

- Room selection should prioritize rooms with appropriate capacity that are currently available
- Participants should be intelligently matched based on keywords mentioned by the user (department, project, name)
- If user doesn't specify duration, default to 30 minutes
- `[✓]` in the form indicates recommended default options
- Always output the form in the exact format shown above for proper frontend rendering
- After the user confirms the booking, you will receive the booking result. Respond with a friendly confirmation message.

## Example Interaction

**User**: Help me schedule a meeting about the AIGC platform, at 3pm, 30 minutes long

**Assistant** (after calling get_meeting_resources):
```markdown
## 📅 会议预约确认 (Meeting Booking Confirmation)

### 会议名称 (Meeting Title)
**Type**: text_input
**Value**: `AIGC平台讨论会议`

### 会议时间 (Meeting Time)
**Type**: datetime_range
**Start**: `2025-01-05T15:00:00`
**End**: `2025-01-05T15:30:00`
**Duration**: `30`

### 会议地点 (Meeting Location)
**Type**: single_choice
**Options**:
- [✓] `room_101` - 会议室A (101) (Recommended)
- [ ] `room_201` - 会议室B (201)
- [ ] `room_102` - 小会议室 (102)

### 参会人员 (Participants)
**Type**: multiple_choice
**Options**:
- [✓] `user_001` - 张三 (Recommended)
- [✓] `user_003` - 王五 (Recommended)
- [ ] `user_002` - 李四
- [ ] `user_004` - 赵六
```

## Error Handling

If the booking fails, you will receive an error message. In this case:
1. Explain to the user what went wrong
2. Suggest possible solutions (e.g., try a different time slot, different room)
3. Offer to help them try again with modified parameters
