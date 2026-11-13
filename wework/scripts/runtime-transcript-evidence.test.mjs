import { describe, expect, it } from 'vitest'
import { runtimeTranscriptBlocks } from '../e2e/desktop/modules/runtime-transcript-evidence.mjs'

describe('runtime interaction evidence', () => {
  const block = (scope, status) => ({
    id: 'request-user-input-0',
    type: 'block',
    block: { render_payload: { interactionScope: scope, interactionStatus: status } },
  })

  it('reads settled executor state after native completion and isolates reused item IDs', () => {
    const response = { answers: { direction: { answers: ['Complete'] } } }
    const answered = block('turn-1', 'answered')
    answered.block.render_payload.response = response
    const transcript = {
      messages: [{ blocks: [block('turn-1', 'pending').block] }],
      turns: [
        { id: 'turn-1', items: [block('turn-1', 'pending')] },
        { id: 'turn-2', items: [block('turn-2', 'pending')] },
      ],
      runtimeTurns: [{ id: 'turn-1', items: [answered] }],
    }
    expect(runtimeTranscriptBlocks(transcript)).toEqual([
      answered.block,
      block('turn-2', 'pending').block,
    ])
  })

  it('rejects incomplete evidence instead of accepting legacy messages', () => {
    expect(() => runtimeTranscriptBlocks({ messages: [] })).toThrow('native turns')
    expect(() => runtimeTranscriptBlocks({ turns: [], messages: [] })).toThrow('runtime overlays')
  })
})
