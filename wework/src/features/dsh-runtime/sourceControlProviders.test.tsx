import { renderHook } from '@testing-library/react'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'
import {
  useSourceControlProviderInstalled,
  useWorkspaceModeProviderInstalled,
} from './sourceControlProviders'

describe('source control DSH providers', () => {
  const providers = [{ id: 'git', workspaceModes: ['git_worktree'] }]
  const missingEntries: never[] = []

  beforeEach(() => {
    const runtime = window.__WEWORK_DSH_UI__
    window.__WEWORK_DSH_UI__ = {
      ...runtime!,
      getEntries: slot =>
        slot === WEWORK_DSH_SLOTS.sourceControlProvider
          ? providers
          : (runtime?.getEntries(slot) ?? missingEntries),
    }
  })

  test('resolves providers by implementation id', () => {
    expect(renderHook(() => useSourceControlProviderInstalled('git')).result.current).toBe(true)
    expect(renderHook(() => useSourceControlProviderInstalled('svn')).result.current).toBe(false)
  })

  test('resolves generic workspace modes independently of provider identity', () => {
    expect(renderHook(() => useWorkspaceModeProviderInstalled('git_worktree')).result.current).toBe(
      true
    )
    expect(renderHook(() => useWorkspaceModeProviderInstalled('svn_branch')).result.current).toBe(
      false
    )
  })
})
