// @vitest-environment node

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deriveRuntimePaneStatus } from '@/features/workbench/runtimePaneStatus'
import {
  compareMessageStyles,
  getWorkbenchDebugSnapshot,
  summarizeMessages,
  summarizeRuntimePaneMemory,
  updateRuntimePaneDebugSnapshot,
  type RuntimePaneDebugSnapshot,
} from './debugPanel'
import {
  clearRuntimePaneTransitions,
  getRuntimePaneTransitions,
  recordRuntimePaneTransition,
  summarizeRuntimeDisplayItems,
} from './runtimePaneDiagnostics'

beforeEach(() => {
  // Node 25 exposes an incomplete experimental Storage object without a backing file.
  // These Node-only diagnostics tests exercise the default state without browser storage.
  vi.stubGlobal('localStorage', undefined)
})

afterEach(() => vi.unstubAllGlobals())

it('keeps bounded, deduplicated evidence from before a held model response is released', () => {
  clearRuntimePaneTransitions()
  for (let i = 0; i < 80; i++) {
    const snapshot = {
      updatedAt: String(i),
      currentRuntimeTask: { taskId: String(i) },
      status: { isAssistantStreaming: true, isWaitingForAssistantIndicator: false, isBusy: true },
      messageSummary: { total: i },
    } as unknown as RuntimePaneDebugSnapshot
    recordRuntimePaneTransition(snapshot)
    recordRuntimePaneTransition(snapshot)
  }
  expect(getRuntimePaneTransitions()).toHaveLength(64)
  expect(getRuntimePaneTransitions()[0].taskId).toBe('16')
  expect(getRuntimePaneTransitions().at(-1)?.streaming).toBe(true)
  clearRuntimePaneTransitions()
  expect(getRuntimePaneTransitions()).toEqual([])
})

it('records native item identities and lengths without copying message text', () => {
  const summary = summarizeRuntimeDisplayItems({
    runtimeDisplayItems: [
      { id: 'native-id', type: 'assistant_text', content: 'private message content' },
    ],
  } as Parameters<typeof summarizeRuntimeDisplayItems>[0])
  expect(summary).toEqual([{ id: 'native-id', type: 'assistant_text', contentLength: 23 }])
  expect(JSON.stringify(summary)).not.toContain('private message')
})

it('retains the opaque older-page cursor for pagination progress diagnostics', () => {
  const address = { deviceId: 'device-1', taskId: 'loaded-task' }
  updateRuntimePaneDebugSnapshot({
    currentRuntimeTask: address,
    status: deriveRuntimePaneStatus({ messages: [], currentRuntimeTask: address, lifecycle: null }),
    messageSummary: summarizeMessages([]),
    messageStyleComparison: compareMessageStyles([]),
    memory: summarizeRuntimePaneMemory({
      messages: [],
      currentRuntimeTask: address,
      loadedRanges: [],
    }),
    queuedMessages: [],
    guidanceMessages: [],
    codeCommentContextCount: 0,
    inputLength: 0,
    transcript: {
      loading: false,
      hasMoreBefore: false,
      loadingMoreBefore: false,
      beforeCursor: 'opaque-older-page',
      turnNavigationCount: 0,
      loadedRanges: [],
    },
    subagentStatuses: [],
    goal: null,
    goalDraftActive: false,
  })

  expect(getWorkbenchDebugSnapshot().pane?.transcript.beforeCursor).toBe('opaque-older-page')
})
