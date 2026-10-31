import { expect, it } from 'vitest'
import type { RuntimePaneDebugSnapshot } from './debugPanel'
import {
  clearRuntimePaneTransitions,
  getRuntimePaneTransitions,
  recordRuntimePaneTransition,
  summarizeRuntimeDisplayItems,
} from './runtimePaneDiagnostics'

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
