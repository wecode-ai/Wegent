---
sidebar_position: 2
---

# Claude Code Model Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable model selection during existing ClaudeCode conversations.

**Architecture:** Add one shared frontend capability helper in `messageService.ts`, then use it in desktop and mobile input controls. The existing send payload and backend/executor model override path remain unchanged.

**Tech Stack:** Next.js 15, React 19, TypeScript, Jest.

---

### Task 1: Add Capability Helper

**Files:**
- Modify: `frontend/src/features/tasks/service/messageService.ts`
- Modify: `frontend/src/__tests__/features/tasks/service/messageService.test.ts`

- [ ] **Step 1: Write failing tests**

Add these tests to `frontend/src/__tests__/features/tasks/service/messageService.test.ts`:

```typescript
import {
  canSwitchModelAfterMessages,
  canUseChatContexts,
} from '@/features/tasks/service/messageService'
import type { Team } from '@/types/api'

function createTeam(agentType: string, shellType?: string): Team {
  return {
    id: 1,
    name: `${agentType} Team`,
    description: '',
    bots: shellType
      ? [
          {
            bot_id: 1,
            bot_prompt: '',
            bot: { shell_type: shellType },
          },
        ]
      : [],
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '',
    updated_at: '',
    agent_type: agentType,
  }
}

describe('messageService canSwitchModelAfterMessages', () => {
  it('allows chat shell teams to switch models after messages exist', () => {
    expect(canSwitchModelAfterMessages(createTeam('chat'))).toBe(true)
  })

  it('allows ClaudeCode teams to switch models after messages exist', () => {
    expect(canSwitchModelAfterMessages(createTeam('ClaudeCode'))).toBe(true)
  })

  it('allows ClaudeCode teams detected from bot shell type', () => {
    expect(canSwitchModelAfterMessages(createTeam('', 'ClaudeCode'))).toBe(true)
  })

  it('keeps unknown shells disabled after messages exist', () => {
    expect(canSwitchModelAfterMessages(createTeam('Dify'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- --runTestsByPath src/__tests__/features/tasks/service/messageService.test.ts`

Expected: FAIL with an export error for `canSwitchModelAfterMessages`.

- [ ] **Step 3: Implement helper**

Add this function to `frontend/src/features/tasks/service/messageService.ts` after `isClaudeCode`:

```typescript
/**
 * Check whether the model selector should stay enabled after a task has messages.
 *
 * Chat Shell already supports per-message model switching. ClaudeCode receives the selected
 * model through the existing task override path and executor model configuration.
 */
export function canSwitchModelAfterMessages(team: Team | null): boolean {
  return isChatShell(team) || isClaudeCode(team)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- --runTestsByPath src/__tests__/features/tasks/service/messageService.test.ts`

Expected: PASS.

### Task 2: Use Helper In Input Controls

**Files:**
- Modify: `frontend/src/features/tasks/components/input/ChatInputControls.tsx`
- Modify: `frontend/src/features/tasks/components/input/MobileChatInputControls.tsx`

- [ ] **Step 1: Update desktop import and disabled rule**

Change the service import in `ChatInputControls.tsx` to include the helper:

```typescript
import {
  canSwitchModelAfterMessages,
  canUseChatContexts,
  isChatShell,
} from '../../service/messageService'
```

Change the model selector disabled prop to:

```tsx
disabled={isLoading || isStreaming || (hasMessages && !canSwitchModelAfterMessages(selectedTeam))}
```

- [ ] **Step 2: Update mobile import and disabled rule**

Change the service import in `MobileChatInputControls.tsx` to include the helper:

```typescript
import {
  canSwitchModelAfterMessages,
  canUseChatContexts,
  isChatShell,
  teamRequiresWorkspace,
} from '../../service/messageService'
```

Change the mobile model selector disabled prop to:

```tsx
disabled={isLoading || isStreaming || (hasMessages && !canSwitchModelAfterMessages(selectedTeam))}
```

- [ ] **Step 3: Run targeted test**

Run: `cd frontend && npm test -- --runTestsByPath src/__tests__/features/tasks/service/messageService.test.ts`

Expected: PASS.

- [ ] **Step 4: Run lint**

Run: `cd frontend && npm run lint`

Expected: PASS.
