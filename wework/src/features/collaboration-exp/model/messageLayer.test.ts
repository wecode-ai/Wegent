// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { selectTaskTimeline } from './timelineSelectors'
import {
  experienceIssueFixture,
  experienceMessageFixture,
  experienceProjectFixture,
} from './fixtures'
import { isPublishedTimelineConclusion } from './messageLayer'

describe('shared assistant message layers', () => {
  const timeline = (overrides: Parameters<typeof experienceMessageFixture>[0]) =>
    selectTaskTimeline({
      project: experienceProjectFixture(),
      issue: experienceIssueFixture(),
      viewer: 7,
      messages: [
        experienceMessageFixture({
          sender: { type: 'agent', id: 'stand-in', name: 'Assistant' },
          content: 'Public conclusion',
          ...overrides,
        }),
      ],
    }).nodes[0]

  it('preserves public assistant text without inventing an execution', () => {
    expect(timeline({})).toMatchObject({
      kind: 'comment',
      body: 'Public conclusion',
      executionAddress: null,
    })
  })

  it('preserves an explicitly public stand-in reply even when a source address exists', () => {
    expect(
      timeline({
        metadata: { execution_dispatch: 'comment_only' },
        runtimeAddress: { deviceId: 'device', taskId: 'task' },
      })
    ).toMatchObject({ kind: 'comment', body: 'Public conclusion', executionAddress: null })
  })

  it.each(['agent_status', 'agent_chunk'] as const)(
    'keeps private %s process output out of public content',
    type => {
      const node = timeline({ type, content: 'PRIVATE-TOOL-OUTPUT' })
      expect(node).toMatchObject({ kind: 'execution', body: null, attachments: [] })
      expect(JSON.stringify(node)).not.toContain('PRIVATE-TOOL-OUTPUT')
    }
  )

  it('keeps agent text public even when it has a runtime source address', () => {
    expect(
      timeline({
        runtimeAddress: { deviceId: 'device', taskId: 'task' },
      })
    ).toMatchObject({
      kind: 'comment',
      body: 'Public conclusion',
      executionAddress: null,
    })
  })

  it('exposes an execution link only for execution message types', () => {
    expect(
      timeline({
        type: 'agent_status',
        runtimeAddress: { deviceId: 'device', taskId: 'task' },
      })
    ).toMatchObject({ kind: 'execution', body: null })
  })

  it('keeps pending AI content as a candidate rather than a final conclusion', () => {
    const pending = timeline({
      generationSource: 'ai',
      publicationSource: 'ai',
      confirmationState: 'pending',
      actorUserId: '8',
      actorDisplayName: 'jiangyang7',
    })
    expect(pending.author).toEqual({ id: '8', name: 'jiangyang7' })
    expect(isPublishedTimelineConclusion(pending)).toBe(false)
    expect(
      isPublishedTimelineConclusion({
        ...pending,
        confirmationState: 'authorized',
        publicationSource: 'human',
      })
    ).toBe(true)
    expect(
      isPublishedTimelineConclusion({
        ...pending,
        confirmationState: 'not_required',
        publicationSource: 'ai',
      })
    ).toBe(true)
  })
})
