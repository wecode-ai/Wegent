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
    expect(() => runtimeTranscriptBlocks({ turns: [], runtimeTurns: {} })).toThrow(
      'runtime overlays'
    )
  })

  it.each([undefined, null, []])('reads native turns with optional overlays %j', runtimeTurns => {
    const question = block('turn-1', 'pending')
    expect(
      runtimeTranscriptBlocks({
        turns: [{ id: 'turn-1', items: [question] }],
        ...(runtimeTurns !== undefined ? { runtimeTurns } : {}),
      })
    ).toEqual([question.block])
  })
})

describe('committed transcript archive evidence', () => {
  it('reads archive metadata after the held commit response becomes available', async () => {
    const { TranscriptBackendEvidence } =
      await import('../e2e/desktop/modules/transcript-backend-evidence.mjs')
    const evidence = new TranscriptBackendEvidence({ backendUrl: 'http://127.0.0.1:1' })
    const archive = { id: 'archive', toSequence: 1, sha256: 'digest' }
    const objectId = 'transcript-1-digest'
    const order = []
    let held = false
    let reads = 0
    evidence.activeTranscriptId = 'transcript'
    evidence.objects.set(objectId, Buffer.from('real object observed by fixture'))
    evidence.firstCommit = {
      status: 200,
      readHeldResponse: () => held,
      dropHeldResponse: () => {
        order.push('drop')
        return true
      },
    }
    evidence.request = async path => {
      if (path === '/api/wework-transcripts') return { items: [{ transcriptId: 'transcript' }] }
      if (path.endsWith('/turns?limit=500')) {
        held = true
        order.push('commit-response')
        return { turns: [] }
      }
      order.push('detail')
      reads++
      return { archives: reads === 1 ? [] : [archive] }
    }
    evidence.deleteObject = async id => {
      expect(id).toBe(objectId)
      expect(evidence.archives.has(id)).toBe(true)
      order.push('delete')
    }
    await evidence.refresh()
    expect(reads).toBe(2)
    expect(order.lastIndexOf('detail')).toBeGreaterThan(order.indexOf('commit-response'))
    expect(order.slice(-2)).toEqual(['delete', 'drop'])
    expect(evidence.firstCommitResponseDropped).toBe(true)
  })
  it('still rejects a missing archive after reading committed backend state', async () => {
    const { TranscriptBackendEvidence } =
      await import('../e2e/desktop/modules/transcript-backend-evidence.mjs')
    const evidence = new TranscriptBackendEvidence({ backendUrl: 'http://127.0.0.1:1' })
    evidence.activeTranscriptId = 'transcript'
    evidence.firstCommit = {
      status: 200,
      readHeldResponse: () => true,
      dropHeldResponse: () => {
        throw new Error('Cannot drop before archive verification')
      },
    }
    evidence.request = async path =>
      path === '/api/wework-transcripts'
        ? { items: [{ transcriptId: 'transcript' }] }
        : path.includes('/turns?')
          ? { turns: [] }
          : { archives: [] }
    await expect(evidence.refresh()).rejects.toThrow('The real committed snapshot must exist')
    expect(evidence.firstCommitResponseDropped).toBe(false)
  })
})
