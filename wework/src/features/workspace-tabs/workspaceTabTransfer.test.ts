import { beforeEach, describe, expect, test } from 'vitest'
import {
  clearStagedWorkspaceTabTransfer,
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
  stageWorkspaceTabTransfer,
} from './workspaceTabTransfer'

describe('workspace tab transfer state', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('stages the live tab draft and consumes it exactly once', () => {
    publishWorkspaceTabTransferState('task-1', {
      draftInputByScope: {
        'blank:0': '保留到新窗口的草稿',
      },
    })

    stageWorkspaceTabTransfer('task-1')

    expect(consumeWorkspaceTabTransfer('task-1')).toEqual({
      draftInputByScope: {
        'blank:0': '保留到新窗口的草稿',
      },
    })
    expect(consumeWorkspaceTabTransfer('task-1')).toBeNull()
  })

  test('clears a staged transfer when window creation fails', () => {
    publishWorkspaceTabTransferState('task-2', {
      draftInputByScope: { 'blank:0': 'temporary' },
    })
    stageWorkspaceTabTransfer('task-2')

    clearStagedWorkspaceTabTransfer('task-2')

    expect(consumeWorkspaceTabTransfer('task-2')).toBeNull()
  })
})
