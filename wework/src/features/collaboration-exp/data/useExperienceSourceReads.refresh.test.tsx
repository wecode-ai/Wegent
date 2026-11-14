import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invalidatesExperienceRead, useExperienceSourceReads } from './useExperienceSourceReads'
import type { ExperienceSource } from './useExperienceSources'

afterEach(cleanup)

function fixture() {
  const source: ExperienceSource = {
    store: 'backend',
    api: {} as SharedWorkspaceApi,
    participationViewer: 7,
  }
  const sources = [source]
  const owners = [{ source, key: 'project-1' }]
  const read = vi.fn().mockResolvedValue({ name: 'Verified project' })
  return { source, sources, owners, read }
}

describe('structured experience read invalidation', () => {
  it.each([
    { status: 401 },
    { statusCode: 403 },
    { status: 404 },
    { status: 410 },
    { code: 'permission_denied' },
    { code: 'AUTHENTICATION_REQUIRED' },
    { code: 'UNAUTHENTICATED' },
    { code: 'SCOPE_FORBIDDEN' },
    { code: 'SCOPE_NOT_FOUND' },
    { errorCode: 'project_session_access_denied' },
    { code: 'wrong_device' },
    { code: 'identity_mismatch' },
    { code: 'source_mismatch' },
    new Error('Wrapped transport failure', { cause: { code: 'http_403' } }),
  ])('invalidates structured ownership/resource failures: %j', error => {
    expect(invalidatesExperienceRead(error)).toBe(true)
  })

  it.each([
    new Error('forbidden is part of private user content'),
    { status: 503, code: 'network_error' },
    { code: 'device_offline' },
    null,
  ])('retains snapshots for transient failures without classifying message text: %j', error => {
    expect(invalidatesExperienceRead(error)).toBe(false)
  })

  it('terminates on a cyclic structured cause', () => {
    const error: { cause?: unknown } = {}
    error.cause = error
    expect(invalidatesExperienceRead(error)).toBe(false)
  })
})

describe('source refresh snapshot ownership', () => {
  it('retains successful same-owner data on network failure and recovers on retry', async () => {
    const { sources, owners, read } = fixture()
    const view = renderHook(
      ({ revision }) =>
        useExperienceSourceReads(sources, owners, true, revision, 'account-7', read),
      { initialProps: { revision: 0 } }
    )
    await waitFor(() => expect(view.result.current[0].value?.name).toBe('Verified project'))
    read.mockRejectedValueOnce(new Error('Network unavailable'))
    view.rerender({ revision: 1 })
    expect(view.result.current[0].value?.name).toBe('Verified project')
    await waitFor(() => expect(view.result.current[0].error).toBe('Network unavailable'))
    expect(view.result.current[0]).toMatchObject({
      value: { name: 'Verified project' },
      loading: false,
    })
    read.mockResolvedValueOnce({ name: 'Updated project' })
    view.rerender({ revision: 2 })
    await waitFor(() => expect(view.result.current[0].value?.name).toBe('Updated project'))
    expect(view.result.current[0].error).toBeNull()
  })

  it.each([{ status: 403 }, { code: 'SCOPE_NOT_FOUND' }, { code: 'source_mismatch' }])(
    'clears data after structured invalidation and does not revive it on a later network failure: %j',
    async error => {
      const { sources, owners, read } = fixture()
      const view = renderHook(
        ({ revision }) =>
          useExperienceSourceReads(sources, owners, true, revision, 'account-7', read),
        { initialProps: { revision: 0 } }
      )
      await waitFor(() => expect(view.result.current[0].value).not.toBeNull())
      read.mockRejectedValueOnce(error)
      view.rerender({ revision: 1 })
      await waitFor(() => expect(view.result.current[0].loading).toBe(false))
      expect(view.result.current[0].value).toBeNull()
      read.mockRejectedValueOnce(new Error('Network unavailable'))
      view.rerender({ revision: 2 })
      await waitFor(() => expect(view.result.current[0].error).toBe('Network unavailable'))
      expect(view.result.current[0].value).toBeNull()
    }
  )

  it.each(['account-7', 'account-8'])(
    'rejects a late superseded read with next scope %s',
    async nextScope => {
      const { sources, owners, read } = fixture()
      let rejectOld!: (reason: Error) => void
      const view = renderHook(
        ({ scope, revision }) =>
          useExperienceSourceReads(sources, owners, true, revision, scope, read),
        { initialProps: { scope: 'account-7', revision: 0 } }
      )
      await waitFor(() => expect(view.result.current[0].value).not.toBeNull())
      read.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject
          })
      )
      view.rerender({ scope: 'account-7', revision: 1 })
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
      read.mockResolvedValueOnce({ name: 'New owner' })
      view.rerender({ scope: nextScope, revision: 2 })
      expect(view.result.current[0].value?.name).toBe(
        nextScope === 'account-7' ? 'Verified project' : undefined
      )
      await waitFor(() => expect(view.result.current[0].value?.name).toBe('New owner'))
      await act(async () => rejectOld(new Error('Outdated failure')))
      expect(view.result.current[0]).toMatchObject({ value: { name: 'New owner' }, error: null })
    }
  )

  it('does not retain a different resource key when its initial read fails', async () => {
    const { source, sources, owners, read } = fixture()
    const view = renderHook(
      ({ selected }) => useExperienceSourceReads(sources, selected, true, 0, 'account-7', read),
      { initialProps: { selected: owners } }
    )
    await waitFor(() => expect(view.result.current[0].value).not.toBeNull())
    read.mockRejectedValueOnce(new Error('Network unavailable'))
    view.rerender({ selected: [{ source, key: 'project-2' }] })
    expect(view.result.current[0].value).toBeNull()
    await waitFor(() => expect(view.result.current[0].loading).toBe(false))
    expect(view.result.current[0].value).toBeNull()
  })
})
