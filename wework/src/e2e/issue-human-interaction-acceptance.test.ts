import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyHumanInteractionIssueAccepted } from '../../e2e/desktop/modules/human-interaction-issue.mjs'
import { readProjectChatMessages } from '../../e2e/desktop/modules/project-chat-snapshot.mjs'
import {
  interactionTranscriptIdentities,
  readInteractionInboxIdentities,
} from '../../e2e/desktop/modules/human-interaction-identity-diagnostics.mjs'

vi.mock('../../e2e/desktop/modules/project-chat-snapshot.mjs', () => ({
  readProjectChatMessages: vi.fn(),
}))

const fixture = {
  backendUrl: 'https://fixture.example',
  authToken: 'synthetic',
  issueId: 'ISSUE-1',
  rootId: 'root',
}
const question = {
  id: 'canonical',
  item_id: 'native-question',
  status: 'resolved',
  answer_message_id: 'answer',
  runtime_task_id: 'task',
}
const reply = {
  messageId: 'answer',
  sender: { type: 'user' },
  content: 'Keep scope',
  rootMessageId: 'root',
  replyToMessageId: 'root',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

function api(item = question) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [item] }) })
  )
  vi.mocked(readProjectChatMessages).mockResolvedValue([reply])
}

describe('Issue acceptance E2E precondition', () => {
  it('captures row identity and kind together while pending rows can disappear', async () => {
    let present = true
    const control = {
      command: vi.fn(async (action: string, selector: string, options: { value: string }) => {
        expect(action).toBe('getElementMetrics')
        const { attributeNames } = JSON.parse(options.value)
        if (selector.includes('workspace-tab-select')) {
          return JSON.stringify([{ attributes: { 'data-pending-question-count': '0' } }])
        }
        if (!selector.includes('interaction-source-group-project') || !present) return '[]'
        expect(attributeNames).toEqual(['data-interaction-id', 'data-project-issue'])
        present = false
        return JSON.stringify([
          {
            attributes: { 'data-interaction-id': 'issue-a', 'data-project-issue': 'true' },
          },
        ])
      }),
    }
    const snapshot = await readInteractionInboxIdentities(control, 'body')
    expect(present).toBe(false)
    expect(snapshot.rows).toEqual([{ source: 'project', id: 'issue-a', projectItem: 'true' }])
    expect(snapshot.counts).toEqual({ 'data-pending-question-count': '0' })
    expect(control.command).toHaveBeenCalledTimes(4)
  })
  it('records actual task origin field types and native IDs without transcript content', () => {
    const result = interactionTranscriptIdentities(
      {
        messages: [
          {
            id: 'message',
            turnId: 'turn',
            content: 'private contents',
            blocks: [
              {
                id: 'block',
                status: 'done',
                render_payload: {
                  kind: 'request_user_input',
                  itemId: 'item',
                  questions: [{ question: 'business contents' }],
                },
              },
            ],
          },
        ],
      },
      {
        runtimeHandle: {
          origin: {
            type: 'board_comment',
            cloudProjectId: 12,
            loopItemId: 'ISSUE-1',
            credential: 'never serialize',
          },
        },
      }
    )
    expect(result.origin.cloudProjectIdType).toBe('number')
    expect(result.origin.loopItemIdType).toBe('string')
    expect(result.native[0].itemId).toBe('item')
    expect(JSON.stringify(result)).not.toMatch(/private contents|business contents|never serialize/)
  })
  it('requires resolved canonical state and the exact persisted answer in the original thread', async () => {
    api()
    const accepted = await verifyHumanInteractionIssueAccepted(
      fixture,
      'native-question',
      'Keep scope',
      1000
    )
    expect(accepted.answer_message_id).toBe('answer')
    expect(accepted.status).toBe('resolved')
    expect(accepted).not.toHaveProperty('question')
  })

  it('does not mistake an answering request for accepted delivery', async () => {
    api({ ...question, status: 'answering' })
    await expect(
      verifyHumanInteractionIssueAccepted(fixture, 'native-question', 'Keep scope', 1)
    ).rejects.toThrow()
    expect(readProjectChatMessages).not.toHaveBeenCalled()
  })

  it.each(['messageId', 'rootMessageId', 'replyToMessageId'])(
    'rejects an answer with mismatched %s',
    async field => {
      api()
      vi.mocked(readProjectChatMessages).mockResolvedValue([{ ...reply, [field]: 'other' }])
      await expect(
        verifyHumanInteractionIssueAccepted(fixture, 'native-question', 'Keep scope', 1000)
      ).rejects.toThrow()
    }
  )
})
