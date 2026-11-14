import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import {
  experienceIssueFixture,
  experienceMessageFixture,
  experienceProjectFixture,
} from '../model/fixtures'
import { useExperienceTimeline } from './useExperienceTimeline'

afterEach(cleanup)

function subscription(messages: ProjectChatMessage[]) {
  return { snapshot: { messages, currentUserId: '7' }, unsubscribe: vi.fn() }
}

function setup(messages: ProjectChatMessage[]) {
  const subscribe = vi.fn().mockResolvedValue(subscription(messages))
  const api = { activity: { subscribe } as unknown as ProjectChatClient } as SharedWorkspaceApi
  const data = {
    project: experienceProjectFixture(),
    issue: experienceIssueFixture(),
    taskBindings: [],
  }
  const view = renderHook(
    ({ revision, issueId }) =>
      useExperienceTimeline(
        api,
        { ...data, issue: { ...data.issue, id: issueId } },
        7,
        null,
        true,
        revision
      ),
    { initialProps: { revision: 0, issueId: data.issue.id } }
  )
  return { ...view, subscribe, data }
}

it.each([[], [experienceMessageFixture()]].map(messages => ({ messages })))(
  'retains a verified same-owner snapshot during transient refresh failure, including empty snapshots',
  async ({ messages }) => {
    const view = setup(messages)
    await waitFor(() => expect(view.result.current.timeline.state).toBe('ready'))
    let rejectRefresh!: (cause: unknown) => void
    view.subscribe.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRefresh = reject
        })
    )
    view.rerender({ revision: 1, issueId: view.data.issue.id })
    expect(view.result.current.timeline.state).toBe('ready')
    await act(async () => rejectRefresh(new Error('Network unavailable')))
    expect(view.result.current.error).toBe('Network unavailable')
    expect(view.result.current.timeline.state).toBe('ready')
    expect(view.result.current.timeline.nodes.filter(node => node.kind === 'comment')).toHaveLength(
      messages.length
    )
  }
)

it.each([
  { status: 401 },
  { status: 403 },
  { status: 404 },
  { status: 410 },
  { code: 'SCOPE_FORBIDDEN' },
  { code: 'SCOPE_NOT_FOUND' },
  { code: 'UNAUTHENTICATED' },
])('invalidates retained history on structured denial %j until a fresh success', async denial => {
  const view = setup([experienceMessageFixture()])
  await waitFor(() => expect(view.result.current.timeline.state).toBe('ready'))
  view.subscribe.mockRejectedValueOnce(Object.assign(new Error('Denied'), denial))
  view.rerender({ revision: 1, issueId: view.data.issue.id })
  await waitFor(() => expect(view.result.current.error).toBe('Denied'))
  expect(view.result.current.timeline).toEqual({ state: 'unknown', nodes: [] })
  view.subscribe.mockRejectedValueOnce(new Error('Network unavailable'))
  view.rerender({ revision: 2, issueId: view.data.issue.id })
  await waitFor(() => expect(view.result.current.error).toBe('Network unavailable'))
  expect(view.result.current.timeline).toEqual({ state: 'unknown', nodes: [] })
  view.rerender({ revision: 3, issueId: view.data.issue.id })
  await waitFor(() => expect(view.result.current.timeline.state).toBe('ready'))
})

it('does not show the previous Issue snapshot while a different owner is loading or fails', async () => {
  const view = setup([experienceMessageFixture()])
  await waitFor(() => expect(view.result.current.timeline.state).toBe('ready'))
  let rejectNext!: (cause: unknown) => void
  view.subscribe.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectNext = reject
      })
  )
  view.rerender({ revision: 1, issueId: 'another-issue' })
  expect(view.result.current.timeline).toEqual({ state: 'unknown', nodes: [] })
  expect(view.result.current.loading).toBe(true)
  await act(async () => rejectNext(new Error('Network unavailable')))
  expect(view.result.current.timeline).toEqual({ state: 'unknown', nodes: [] })
})
