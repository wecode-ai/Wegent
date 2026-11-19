import { getWorkbenchPaneKey } from './workbenchPaneIdentity'
import type { RuntimeTaskAddress } from '@/types/api'
import { retainElectronEmbeddedBrowserView } from './workspace-panels/electronEmbeddedBrowserHost'
import { markEmbeddedBrowserLabelTransferred } from '@/lib/embedded-browser'
import type { SetStateAction } from 'react'
import type { EmbeddedBrowserOpenRequest } from '@/lib/embedded-browser'
import { listenEmbeddedBrowserOpenRequests } from '@/lib/embedded-browser'
import type { WorkbenchPaneWorkspaceState } from './desktopWorkbenchMainHelpers'

interface WorkspaceSnapshot {
  resourceOwnersByPane: Record<string, string[]>
  pendingBrowserOpenRequests: Record<string, EmbeddedBrowserOpenRequest>
}
interface WorkspaceRouting {
  activePaneKey: string
  runtimePaneKeysKey: string
  resolveBrowserOpenRequestPaneKey(request: EmbeddedBrowserOpenRequest): string | null
}

/** Own retained pane state and native browser requests for this workbench surface. */
export function createDesktopWorkbenchWorkspaceSource() {
  let snapshot: WorkspaceSnapshot = { resourceOwnersByPane: {}, pendingBrowserOpenRequests: {} }
  const paneWorkspaceStates = new Map<string, WorkbenchPaneWorkspaceState>()
  const provisionalTransfers = new Map<string, symbol>()
  const paneOwnerListeners = new Set<() => void>()
  const listeners = new Set<() => void>()
  let routing: WorkspaceRouting | null = null
  let nativeListener: ReturnType<typeof listenEmbeddedBrowserOpenRequests> = null
  let validPaneKeys = new Set<string>()
  let generation = 0
  let bindingGeneration = 0
  const publish = () => {
    for (const listener of listeners) listener()
  }
  function update<K extends keyof WorkspaceSnapshot>(
    key: K,
    value: SetStateAction<WorkspaceSnapshot[K]>
  ) {
    const next = typeof value === 'function' ? value(snapshot[key]) : value
    if (next === snapshot[key]) return
    snapshot = { ...snapshot, [key]: next }
    publish()
  }
  return {
    readPaneWorkspaceState: (key: string) => paneWorkspaceStates.get(key),
    rememberPaneWorkspaceState(key: string, value: WorkbenchPaneWorkspaceState) {
      provisionalTransfers.delete(key)
      paneWorkspaceStates.set(key, value)
    },
    transferPaneWorkspaceState(sourceKey: string, address: RuntimeTaskAddress) {
      const target = getWorkbenchPaneKey({ currentRuntimeTask: address, currentProject: null })
      if (paneWorkspaceStates.has(target)) {
        provisionalTransfers.delete(target)
        return
      }
      const source = paneWorkspaceStates.get(sourceKey)
      if (!source) return
      for (const browser of Object.values(source.browserStates ?? {})) {
        if (!browser?.label) continue
        retainElectronEmbeddedBrowserView(browser.label)
        markEmbeddedBrowserLabelTransferred(browser.label)
      }
      const transferred = {
        ...source,
        transferredFromBlank: sourceKey.startsWith('blank:'),
      }
      const receipt = Symbol('workspace-transfer')
      provisionalTransfers.set(target, receipt)
      paneWorkspaceStates.set(target, transferred)
      return () => {
        if (
          provisionalTransfers.get(target) !== receipt ||
          paneWorkspaceStates.get(target) !== transferred
        )
          return
        provisionalTransfers.delete(target)
        paneWorkspaceStates.delete(target)
      }
    },
    hasPane(key: string) {
      return key === routing?.activePaneKey || !key.startsWith('runtime:') || validPaneKeys.has(key)
    },
    subscribePaneOwners(listener: () => void) {
      paneOwnerListeners.add(listener)
      return () => {
        paneOwnerListeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    setResourceOwnersByPane: (value: SetStateAction<WorkspaceSnapshot['resourceOwnersByPane']>) =>
      update('resourceOwnersByPane', value),
    setPendingBrowserOpenRequests: (
      value: SetStateAction<WorkspaceSnapshot['pendingBrowserOpenRequests']>
    ) => update('pendingBrowserOpenRequests', value),
    observe(next: WorkspaceRouting) {
      return {
        subscribe(listener: () => void) {
          const previousRouting = routing
          routing = next
          if (previousRouting?.runtimePaneKeysKey !== next.runtimePaneKeysKey) {
            const nextValidKeys = new Set<string>(JSON.parse(next.runtimePaneKeysKey))
            // An unlisted task can be a newly admitted creation; only removals are authoritative.
            for (const key of validPaneKeys) {
              if (nextValidKeys.has(key)) continue
              provisionalTransfers.delete(key)
              paneWorkspaceStates.delete(key)
            }
            validPaneKeys = nextValidKeys
          }
          if (
            previousRouting?.runtimePaneKeysKey !== next.runtimePaneKeysKey ||
            previousRouting?.activePaneKey !== next.activePaneKey
          )
            for (const listener of paneOwnerListeners) listener()
          listeners.add(listener)
          generation += 1
          if (!nativeListener) {
            const binding = ++bindingGeneration
            nativeListener = listenEmbeddedBrowserOpenRequests(request => {
              if (!listeners.size || binding !== bindingGeneration) return
              const paneKey = routing?.resolveBrowserOpenRequestPaneKey(request)
              if (!paneKey) return
              update('pendingBrowserOpenRequests', current => ({ ...current, [paneKey]: request }))
            })
          }
          return () => {
            listeners.delete(listener)
            const closedGeneration = ++generation
            queueMicrotask(() => {
              if (listeners.size || generation !== closedGeneration) return
              bindingGeneration += 1
              const previous = nativeListener
              nativeListener = null
              void previous
                ?.then(unlisten => unlisten())
                .catch(error =>
                  console.error('[Wework] Failed to release browser request routing', error)
                )
            })
          }
        },
      }
    },
  }
}
