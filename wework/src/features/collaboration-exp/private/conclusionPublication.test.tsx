import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import {
  experienceIssueFixture as issue,
  experienceProjectFixture as project,
} from '../model/fixtures'
import { useConclusionPublication } from './useConclusionPublication'
import { useExperienceDraftInput } from '../useExperienceDraftInput'
import { createProjectChatComments } from '@/features/collaboration/projectChatComments'
import type { ProjectChatClient } from '@wegent/chat-core'
import { experienceMessageFixture } from '../model/fixtures'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

let nextAccount = 0
function fixture() {
  const getProject = vi.fn(async () => project())
  const getIssue = vi.fn(async () => issue())
  const create = vi.fn(async () => ({ id: 'comment-1' }))
  const onPublished = vi.fn(async () => {})
  const api = {
    projects: { get: getProject },
    issues: { get: getIssue },
    comments: { create },
  } as unknown as SharedWorkspaceApi
  return { api, getProject, getIssue, create, onPublished, accountKey: `account-${nextAccount++}` }
}

function setup(f = fixture()) {
  const hook = renderHook(
    ({ scopeKey = 'scope-1', active = true } = {}) => {
      const drafts = useExperienceDraftInput({
        accountKey: f.accountKey,
        scopeKey,
        initialValue: '  Edited conclusion only  ',
      })
      const text = drafts.value
      const setText = drafts.setValue
      const publication = useConclusionPublication({
        api: f.api,
        accountKey: f.accountKey,
        project: project(),
        issue: issue(),
        scopeKey,
        active,
        expectedUserId: 7,
        draft: {
          value: text,
          revision: drafts.revision,
          getValue: drafts.getValue,
          beginSubmission: drafts.beginSubmission,
        },
        onPublished: f.onPublished,
      })
      return { ...publication, text, setText }
    },
    { initialProps: { scopeKey: 'scope-1', active: true } }
  )
  return { ...f, ...hook }
}

describe('explicit conclusion publication', () => {
  it.each(['New conclusion', '  Edited conclusion only  '])(
    'preserves a remounted edited draft, including edit away and back: %s',
    async nextDraft => {
      const base = fixture()
      const pending = deferred<{ id: string }>()
      base.create.mockReturnValueOnce(pending.promise)
      const first = setup(base)
      let operation!: Promise<boolean>
      act(() => {
        operation = first.result.current.publish()
      })
      await waitFor(() => expect(base.create).toHaveBeenCalledTimes(1))
      first.unmount()
      const second = setup(base)
      act(() => {
        second.result.current.setText('Intervening edit')
        second.result.current.setText(nextDraft)
      })
      await act(async () => {
        pending.resolve({ id: 'comment-1' })
        expect(await operation).toBe(true)
      })
      expect(second.result.current.text).toBe(nextDraft)
      second.unmount()
      const restored = setup(base)
      expect(restored.result.current.text).toBe(nextDraft)
    }
  )

  it('reuses a persisted native message intent after server commit loses its acknowledgement, without automatic retry', async () => {
    const base = fixture()
    const canonical = new Map<string, ReturnType<typeof experienceMessageFixture>>()
    let loseAck = true
    const send = vi.fn(async (input: Parameters<ProjectChatClient['send']>[0]) => {
      const key = JSON.stringify([input.projectId, input.taskId, input.clientMessageId])
      let message = canonical.get(key)
      if (message && message.content !== input.text)
        throw new Error('Client identity reused with another body')
      if (!message) {
        message = experienceMessageFixture({
          messageId: `canonical-${canonical.size + 1}`,
          clientMessageId: input.clientMessageId,
          content: input.text,
        })
        canonical.set(key, message)
      }
      if (loseAck) {
        loseAck = false
        throw new Error('Acknowledgement timed out after commit')
      }
      return message
    })
    base.api.comments = createProjectChatComments(
      { send } as unknown as ProjectChatClient,
      async () => 'project-1'
    )
    const first = setup(base)
    await act(async () => expect(await first.result.current.publish()).toBe(false))
    expect(canonical.size).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(first.result.current.text).toContain('Edited conclusion')
    first.unmount()
    const restored = setup(base)
    base.getProject.mockResolvedValueOnce(project({ access_role: 'Viewer' }))
    await act(async () => expect(await restored.result.current.publish()).toBe(false))
    expect(send).toHaveBeenCalledTimes(1)
    await act(async () => expect(await restored.result.current.publish()).toBe(true))
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0].clientMessageId).toBe(send.mock.calls[1][0].clientMessageId)
    expect(canonical.size).toBe(1)
    expect(base.getProject).toHaveBeenCalledTimes(3)
    expect(base.getIssue).toHaveBeenCalledTimes(3)
    expect(restored.result.current.text).toBe('')
    act(() => restored.result.current.setText('Edited conclusion only'))
    await act(async () => expect(await restored.result.current.publish()).toBe(true))
    expect(send.mock.calls[2][0].clientMessageId).not.toBe(send.mock.calls[0][0].clientMessageId)
    expect(canonical.size).toBe(2)
  })

  it('coordinates the same account and native scope across API replacement and remount while a write finishes', async () => {
    const base = fixture()
    const pending = deferred<{ id: string }>()
    base.create.mockReturnValue(pending.promise)
    const first = setup(base)
    let operation!: Promise<boolean>
    act(() => {
      operation = first.result.current.publish()
    })
    await waitFor(() => expect(base.create).toHaveBeenCalledTimes(1))
    first.unmount()
    const replacement = fixture()
    const second = setup({ ...replacement, accountKey: base.accountKey })
    await act(async () => expect(await second.result.current.publish()).toBe(false))
    expect(replacement.create).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve({ id: 'comment-1' })
      expect(await operation).toBe(true)
      expect(await second.result.current.publish()).toBe(false)
    })
    act(() => second.result.current.setText('A new explicitly edited conclusion'))
    await act(async () => expect(await second.result.current.publish()).toBe(true))
    expect(replacement.create).toHaveBeenCalledExactlyOnceWith(
      'EXP-1',
      'A new explicitly edited conclusion',
      { clientMessageId: expect.any(String) }
    )
  })

  it('keeps an in-flight publication isolated from another account using the same native scope', async () => {
    const base = fixture()
    const pending = deferred<{ id: string }>()
    base.create.mockReturnValue(pending.promise)
    const first = setup(base)
    let operation!: Promise<boolean>
    act(() => {
      operation = first.result.current.publish()
    })
    await waitFor(() => expect(base.create).toHaveBeenCalledTimes(1))
    const second = setup()
    await act(async () => expect(await second.result.current.publish()).toBe(true))
    await act(async () => {
      pending.resolve({ id: 'comment-1' })
      expect(await operation).toBe(true)
    })
    expect(first.create).toHaveBeenCalledTimes(1)
    expect(second.create).toHaveBeenCalledTimes(1)
  })

  it('rejects the same completed request even before React commits its cleared draft', async () => {
    const f = setup()
    await act(async () => {
      expect(await f.result.current.publish()).toBe(true)
      expect(await f.result.current.publish()).toBe(false)
    })
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('rejects an old request after edits restore the same text', async () => {
    const base = fixture()
    const pending = deferred<ReturnType<typeof project>>()
    base.getProject.mockReturnValue(pending.promise)
    const f = setup(base)
    let operation!: Promise<boolean>
    act(() => {
      operation = f.result.current.publish()
    })
    act(() => {
      f.result.current.setText('Replaced draft')
      f.result.current.setText('  Edited conclusion only  ')
    })
    await act(async () => {
      pending.resolve(project())
      expect(await operation).toBe(false)
    })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.result.current.text).toBe('  Edited conclusion only  ')
  })

  it('rereads both permissions and publishes only the edited body once, then clears the draft and refreshes', async () => {
    const f = setup()
    await act(async () => {
      const first = f.result.current.publish()
      expect(await f.result.current.publish()).toBe(false)
      expect(await first).toBe(true)
    })
    expect(f.getProject).toHaveBeenCalledWith('project-1')
    expect(f.getIssue).toHaveBeenCalledWith('EXP-1')
    expect(f.create).toHaveBeenCalledExactlyOnceWith('EXP-1', 'Edited conclusion only', {
      clientMessageId: expect.any(String),
    })
    expect(f.onPublished).toHaveBeenCalledTimes(1)
    expect(f.result.current.text).toBe('')
    await act(async () => {
      expect(await f.result.current.publish()).toBe(false)
    })
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it.each(['permission', 'archived', 'project-archived', 'identity'] as const)(
    'retains text when fresh state rejects publication: %s',
    async reason => {
      const base = fixture()
      if (reason === 'permission')
        base.getProject.mockResolvedValue(project({ access_role: 'Viewer' }))
      if (reason === 'project-archived')
        base.getProject.mockResolvedValue(project({ status: 'archived' }))
      if (reason === 'archived')
        base.getIssue.mockResolvedValue(issue({ archived_at: '2026-11-04T00:00:00Z' }))
      if (reason === 'identity') base.getProject.mockResolvedValue(project({ current_user_id: 8 }))
      const f = setup(base)
      await act(async () => {
        expect(await f.result.current.publish()).toBe(false)
      })
      expect(f.create).not.toHaveBeenCalled()
      expect(f.result.current.text).toContain('Edited conclusion')
      expect(f.result.current.error).toBe(
        reason === 'project-archived' ? 'archived' : reason === 'identity' ? 'stale' : reason
      )
    }
  )

  it('keeps a failed draft and does not retry reads or writes automatically', async () => {
    const base = fixture()
    base.create.mockRejectedValue(new Error('Connection lost'))
    const f = setup(base)
    await act(async () => {
      expect(await f.result.current.publish()).toBe(false)
    })
    expect(f.result.current.text).toContain('Edited conclusion')
    expect(f.result.current.error).toBe('failed')
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.onPublished).not.toHaveBeenCalled()
  })

  it.each(['edit', 'scope', 'inactive', 'unmount'] as const)(
    'rejects a replaced permission-read request before any write: %s',
    async change => {
      const base = fixture()
      const pending = deferred<ReturnType<typeof project>>()
      base.getProject.mockReturnValue(pending.promise)
      const f = setup(base)
      let operation!: Promise<boolean>
      act(() => {
        operation = f.result.current.publish()
      })
      if (change === 'edit') act(() => f.result.current.setText('Newer unsent conclusion'))
      if (change === 'scope') f.rerender({ scopeKey: 'scope-2', active: true })
      if (change === 'inactive') f.rerender({ scopeKey: 'scope-1', active: false })
      if (change === 'unmount') f.unmount()
      await act(async () => {
        pending.resolve(project())
        expect(await operation).toBe(false)
      })
      expect(f.create).not.toHaveBeenCalled()
      if (change === 'edit') expect(f.result.current.text).toBe('Newer unsent conclusion')
    }
  )

  it('preserves newer edits while an accepted write finishes and never duplicates after refresh fails', async () => {
    const base = fixture()
    const pending = deferred<{ id: string }>()
    base.create.mockReturnValue(pending.promise)
    base.onPublished.mockRejectedValue(new Error('Stream refresh failed'))
    const f = setup(base)
    let operation!: Promise<boolean>
    await act(async () => {
      operation = f.result.current.publish()
    })
    act(() => f.result.current.setText('Keep this newer draft'))
    await act(async () => {
      pending.resolve({ id: 'comment-1' })
      expect(await operation).toBe(true)
    })
    expect(f.result.current.text).toBe('Keep this newer draft')
    expect(f.result.current.error).toBe('refresh')
    expect(f.create).toHaveBeenCalledTimes(1)
  })
})
