import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type {
  PluginAccessResponse,
  PluginMarketplaceItem,
  PluginSubmissionCompleteResponse,
} from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginVersionSubmitDrawerProps } from '../PluginVersionSubmitDrawer'
import { usePluginVersionSubmission } from './usePluginVersionSubmission'

type Options = Parameters<typeof usePluginVersionSubmission>[0]
type Result = { current: ReturnType<typeof usePluginVersionSubmission> }

const source = {
  id: 'source',
  name: 'Personal plugin',
  version: '2.0.0',
  origin: 'created',
  raw: {
    spec: { source: { type: 'local', marketplace: 'wework-personal', pluginKey: 'personal' } },
  },
} as InstalledPluginItem
const listing = {
  id: 1,
  name: 'personal',
  version: '1.0.0',
  accessRole: 'owner',
  visibility: 'personal',
  latestReleaseId: 10,
} as PluginMarketplaceItem
const access = {
  pluginId: 1,
  scope: 'restricted',
  targets: [{ entityType: 'user', entityId: '2', displayName: 'Recipient' }],
  allowCopy: true,
} as PluginAccessResponse
const completed = {
  submission: { id: 3, releaseId: 11, status: 'approved' },
  plugin: { ...listing, version: '2.0.0', latestReleaseId: 11 },
} as PluginSubmissionCompleteResponse

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function options(): Options {
  return {
    scopeKey: 'account',
    pluginApi: {
      getMarketplacePluginAccess: vi.fn().mockResolvedValue(access),
      publishSubmission: vi.fn().mockResolvedValue(completed),
    },
    localPluginApi: {
      packageCreatedPlugin: vi.fn().mockResolvedValue(new File(['package'], 'personal.zip')),
    },
    onPublished: vi.fn().mockResolvedValue(undefined),
    onNotice: vi.fn(),
    onManageAccess: vi.fn().mockResolvedValue(undefined),
  }
}

function drawer(result: Result) {
  return result.current.drawer as ReactElement<PluginVersionSubmitDrawerProps>
}

async function open(result: Result) {
  act(() => result.current.actionFor(source, listing)!.onSubmit())
  await waitFor(() => expect(result.current.drawer).not.toBeNull())
}

describe('usePluginVersionSubmission request lifetime', () => {
  test('ignores an access error after the workspace unmounts', async () => {
    const input = options()
    const pending = deferred<PluginAccessResponse>()
    vi.mocked(input.pluginApi.getMarketplacePluginAccess).mockReturnValue(pending.promise)
    const { result, unmount } = renderHook(() => usePluginVersionSubmission(input))
    act(() => result.current.actionFor(source, listing)!.onSubmit())
    unmount()

    await act(async () => pending.reject(new Error('Late access failure')))

    expect(input.onNotice).not.toHaveBeenCalled()
  })

  test('does not upload a package that finishes after unmount', async () => {
    const input = options()
    const pending = deferred<File>()
    vi.mocked(input.localPluginApi.packageCreatedPlugin).mockReturnValue(pending.promise)
    const { result, unmount } = renderHook(() => usePluginVersionSubmission(input))
    await open(result)
    act(() => drawer(result).props.onSubmit('Update queries'))
    expect(input.localPluginApi.packageCreatedPlugin).toHaveBeenCalledOnce()
    unmount()

    await act(async () => pending.resolve(new File(['package'], 'personal.zip')))

    expect(input.pluginApi.publishSubmission).not.toHaveBeenCalled()
    expect(input.onPublished).not.toHaveBeenCalled()
  })

  test('does not revive a package request when the account switches away and back', async () => {
    const input = options()
    const pending = deferred<File>()
    vi.mocked(input.localPluginApi.packageCreatedPlugin).mockReturnValue(pending.promise)
    const { result, rerender } = renderHook(
      ({ scopeKey }) => usePluginVersionSubmission({ ...input, scopeKey }),
      { initialProps: { scopeKey: 'account' } }
    )
    await open(result)
    act(() => drawer(result).props.onSubmit('Update queries'))
    rerender({ scopeKey: 'other-account' })
    rerender({ scopeKey: 'account' })

    await act(async () => pending.resolve(new File(['package'], 'personal.zip')))

    expect(input.pluginApi.publishSubmission).not.toHaveBeenCalled()
    expect(result.current.drawer).toBeNull()
  })

  test('ignores a completed publication after unmount', async () => {
    const input = options()
    const pending = deferred<PluginSubmissionCompleteResponse>()
    vi.mocked(input.pluginApi.publishSubmission).mockReturnValue(pending.promise)
    const { result, unmount } = renderHook(() => usePluginVersionSubmission(input))
    await open(result)
    act(() => drawer(result).props.onSubmit('Update queries'))
    await waitFor(() => expect(input.pluginApi.publishSubmission).toHaveBeenCalledOnce())
    unmount()

    await act(async () => pending.resolve(completed))

    expect(input.onPublished).not.toHaveBeenCalled()
    expect(input.onNotice).not.toHaveBeenCalled()
  })

  test('invalidates integration callbacks and success notices on unmount', async () => {
    const input = options()
    const pending = deferred<void>()
    vi.mocked(input.onPublished).mockReturnValue(pending.promise)
    const { result, unmount } = renderHook(() => usePluginVersionSubmission(input))
    await open(result)
    act(() => drawer(result).props.onSubmit('Update queries'))
    await waitFor(() => expect(input.onPublished).toHaveBeenCalledOnce())
    const isCurrent = vi.mocked(input.onPublished).mock.calls[0][2]
    expect(isCurrent()).toBe(true)
    unmount()
    expect(isCurrent()).toBe(false)

    await act(async () => pending.resolve())

    expect(input.onNotice).not.toHaveBeenCalled()
  })

  test('integrates and reports a successful submission in the active lifetime', async () => {
    const input = options()
    const { result } = renderHook(() => usePluginVersionSubmission(input))
    await open(result)
    act(() => drawer(result).props.onSubmit('  Update queries  '))

    await waitFor(() =>
      expect(input.onNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
    )

    expect(input.pluginApi.publishSubmission).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({
        slug: 'personal',
        version: '2.0.0',
        releaseNotes: 'Update queries',
      })
    )
    expect(input.onPublished).toHaveBeenCalledOnce()
    expect(result.current.drawer).toBeNull()
  })
})

describe('usePluginVersionSubmission source identity', () => {
  const namedSource = {
    ...source,
    name: 'GitLab Engineering',
    raw: {
      spec: {
        source: {
          type: 'local',
          marketplace: 'wework-personal',
          pluginKey: 'GitLab Engineering',
        },
      },
    },
  } as InstalledPluginItem
  const namedListing = { ...listing, name: 'GitLab Engineering' }

  test('submits the normalized slug from a legal mixed-case manifest name', async () => {
    const input = options()
    const { result } = renderHook(() => usePluginVersionSubmission(input))
    const action = result.current.actionFor(namedSource, namedListing)
    expect(action).toBeDefined()
    act(() => action!.onSubmit())
    await waitFor(() => expect(result.current.drawer).not.toBeNull())

    act(() => drawer(result).props.onSubmit('Update GitLab queries'))

    await waitFor(() => expect(input.onPublished).toHaveBeenCalledOnce())
    expect(input.localPluginApi.packageCreatedPlugin).toHaveBeenCalledWith(namedSource.raw)
    expect(input.pluginApi.publishSubmission).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({
        slug: 'gitlab-engineering',
        displayName: 'GitLab Engineering',
        version: '2.0.0',
        releaseNotes: 'Update GitLab queries',
      })
    )
  })

  test('does not expose or prepare submissions for recipients or a different source', () => {
    const input = options()
    const { result } = renderHook(() => usePluginVersionSubmission(input))

    expect(
      result.current.actionFor(namedSource, { ...namedListing, accessRole: 'recipient' })
    ).toBeUndefined()
    expect(result.current.actionFor(source, namedListing)).toBeUndefined()
    expect(input.pluginApi.getMarketplacePluginAccess).not.toHaveBeenCalled()
    expect(input.localPluginApi.packageCreatedPlugin).not.toHaveBeenCalled()
    expect(input.pluginApi.publishSubmission).not.toHaveBeenCalled()
  })
})
