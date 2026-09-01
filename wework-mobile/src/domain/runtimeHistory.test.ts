import { describe, expect, it } from 'vitest'

import { runtimeHistoryTurnsToMessages } from './runtimeHistory'

describe('runtimeHistoryTurnsToMessages', () => {
  it('promotes paginated file-change blocks into the assistant summary', () => {
    const messages = runtimeHistoryTurnsToMessages([
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'file-change-1',
            type: 'block',
            block: {
              id: 'file-change-1',
              type: 'file_changes',
              file_changes: {
                file_count: 1,
                additions: 2,
                deletions: 0,
                files: [
                  {
                    path: 'created.txt',
                    change_type: 'created',
                    additions: 2,
                    deletions: 0,
                    binary: false,
                  },
                ],
              },
            },
          },
          {
            id: 'answer-1',
            type: 'assistant_text',
            content: 'done',
          },
        ],
      },
    ])

    expect(messages).toEqual([
      {
        id: 'assistant-turn-1',
        role: 'assistant',
        subtaskId: 'turn-1',
        turnId: 'turn-1',
        content: 'done',
        status: 'completed',
        fileChanges: {
          fileCount: 1,
          additions: 2,
          deletions: 0,
          files: [
            {
              path: 'created.txt',
              change_type: 'created',
              changeType: 'created',
              additions: 2,
              deletions: 0,
              binary: false,
            },
          ],
        },
      },
    ])
  })

  it('keeps a file-only assistant turn', () => {
    const messages = runtimeHistoryTurnsToMessages([
      {
        id: 'turn-file-only',
        status: 'completed',
        items: [
          {
            id: 'file-change-only',
            type: 'block',
            block: {
              id: 'file-change-only',
              type: 'file_changes',
              fileChanges: {
                fileCount: 1,
                additions: 1,
                deletions: 0,
                files: [{ path: 'only.txt', changeType: 'created', additions: 1, deletions: 0 }],
              },
            },
          },
        ],
      },
    ])

    expect(messages).toEqual([
      {
        id: 'assistant-turn-file-only',
        role: 'assistant',
        subtaskId: 'turn-file-only',
        turnId: 'turn-file-only',
        content: '',
        status: 'completed',
        fileChanges: {
          fileCount: 1,
          additions: 1,
          deletions: 0,
          files: [
            {
              path: 'only.txt',
              changeType: 'created',
              additions: 1,
              deletions: 0,
            },
          ],
        },
      },
    ])
  })
})
