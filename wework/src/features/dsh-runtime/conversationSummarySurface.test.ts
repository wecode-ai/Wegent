import { describe, expect, test } from 'vitest'

import { WEWORK_HOST_SERVICES } from './conversationHostServices'
import { hasMatchingConversationSummaryHostService } from './conversationSummarySurface'
import type { WeworkDshSlotEntry } from './dshUiSlots'

describe('hasMatchingConversationSummaryHostService', () => {
  const entries: WeworkDshSlotEntry[] = [
    {
      id: 'git',
      requiredHostServices: [WEWORK_HOST_SERVICES.environment],
      when: { key: 'workspace.isGitRepository', notEquals: false },
    },
    {
      id: 'outputs',
      requiredHostServices: [WEWORK_HOST_SERVICES.conversationOutputs],
      when: { key: 'workspace.isGitRepository', equals: false },
    },
  ]

  test('loads an unresolved environment once so the host can classify the workspace', () => {
    expect(
      hasMatchingConversationSummaryHostService(
        entries,
        { 'workspace.isGitRepository': undefined },
        WEWORK_HOST_SERVICES.environment
      )
    ).toBe(true)
  })

  test('stops environment work after the workspace is classified as non-Git', () => {
    expect(
      hasMatchingConversationSummaryHostService(
        entries,
        { 'workspace.isGitRepository': false },
        WEWORK_HOST_SERVICES.environment
      )
    ).toBe(false)
    expect(
      hasMatchingConversationSummaryHostService(
        entries,
        { 'workspace.isGitRepository': false },
        WEWORK_HOST_SERVICES.conversationOutputs
      )
    ).toBe(true)
  })
})
