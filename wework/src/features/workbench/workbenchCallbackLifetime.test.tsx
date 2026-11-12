import { Session } from 'node:inspector'
import providerSource from './WorkbenchProvider.tsx?raw'
import { setImmediate } from 'node:timers/promises'
import { renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test } from 'vitest'
import type { WorkbenchState } from '@/types/workbench'
import type { RuntimeProjectSyncTarget } from '@/lib/runtime-project-identity'
import { useDismissTrialGuideForScope } from './useWorkbenchComposerCallbacks'
import { useClearRemoteProjectSyncRemoval } from './useWorkbenchNavigationCallbacks'
import { initialWorkbenchState } from './workbenchReducer'

async function collectGarbage() {
  // A new job releases WeakRef's mandatory keep-alive interval.
  await setImmediate()
  const session = new Session()
  session.connect()
  try {
    await new Promise<void>((resolve, reject) => {
      session.post('HeapProfiler.collectGarbage', error => (error ? reject(error) : resolve()))
    })
  } finally {
    session.disconnect()
  }
}

describe('workbench callback lifetime', () => {
  test('releases historical snapshots when callback dependencies change at different rates', async () => {
    const removedRemoteProjectsRef = { current: [] as RuntimeProjectSyncTarget[] }
    const remoteProjectSyncSignatureRef = { current: '' }
    const snapshots: WeakRef<WorkbenchState>[] = []
    const makeState = (devices: WorkbenchState['devices']): WorkbenchState => ({
      ...initialWorkbenchState,
      devices,
      projects: [],
    })
    const { result, rerender, unmount } = renderHook(
      ({ state, scope }) => {
        const [, setNames] = useState<Record<string, string>>({})
        const [, setTemplates] = useState({})
        const [, setApps] = useState({})
        const clear = useClearRemoteProjectSyncRemoval({
          state,
          removedRemoteProjectsRef,
          remoteProjectSyncSignatureRef,
        })
        const dismiss = useDismissTrialGuideForScope({
          trialPluginName: '',
          projectChatScopeKey: scope,
          setTrialPluginNameByScope: setNames,
          setTrialTemplatesByScope: setTemplates,
          setTrialPluginAppByScope: setApps,
        })
        return { clear, dismiss }
      },
      { initialProps: { state: makeState([]), scope: 'scope:0' } }
    )

    let devices: WorkbenchState['devices'] = []
    for (let index = 0; index < 40; index++) {
      if (index % 2 === 0) devices = []
      const state = makeState(devices)
      snapshots.push(new WeakRef(state))
      rerender({ state, scope: `scope:${Math.floor(index / 3)}` })
    }
    await collectGarbage()
    expect(snapshots.slice(4, -4).filter(ref => ref.deref() !== undefined)).toHaveLength(0)
    expect(result.current.clear).toBeTypeOf('function')
    expect(result.current.dismiss).toBeTypeOf('function')
    unmount()
  })

  test('keeps memoized callback bodies outside the provider render scope', () => {
    expect(providerSource).not.toMatch(/\buseCallback\s*\(/)
  })
})
