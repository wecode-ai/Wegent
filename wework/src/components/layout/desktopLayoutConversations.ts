import { bindDshConversationController } from '@/features/dsh-runtime/dshExtensions'
import {
  conversationReferenceKey,
  loadDshConversationTranscript,
  readConversationAssetChunk,
} from '@/features/dsh-runtime/dshConversationTranscript'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type {
  WeworkConversationSnapshot,
  WeworkConversationAssetChunk,
} from '../../../dsh/app-wework/client'

export interface DesktopLayoutConversationInput {
  runtimeWork: WorkbenchContextValue['state']['runtimeWork']
  loadTranscript: WorkbenchContextValue['loadRuntimeTranscriptForPane']
}
interface Owner {
  ownershipKey: string
  inputs(): DesktopLayoutConversationInput
  isHeld(): boolean
  isActive(): boolean
}
interface BridgeOwner {
  ownershipKey: string
}
const bridgeOwners = new WeakMap<NonNullable<Window['__WEWORK_DSH_APP_BRIDGE__']>, BridgeOwner>()

/** Native exports and their authorized asset chunks belong to one layout account and window. */
export function createDesktopLayoutConversations(owner: Owner) {
  const snapshots = new Map<string, WeworkConversationSnapshot>()
  let unbind: (() => void) | null = null
  let boundBridge: Window['__WEWORK_DSH_APP_BRIDGE__'] | null = null
  let exportBridge: Window['__WEWORK_DSH_APP_BRIDGE__'] | null = null
  let exportOwner: BridgeOwner | null = null
  let generation = 0
  const assertCurrent = (version: number) => {
    if (
      !owner.isHeld() ||
      version !== generation ||
      !exportBridge ||
      bridgeOwners.get(exportBridge) !== exportOwner
    )
      throw new Error('Conversation export owner has closed')
  }
  const controller: Parameters<typeof bindDshConversationController>[0] = {
    async getTranscript(reference) {
      const version = generation
      assertCurrent(version)
      const input = owner.inputs()
      const snapshot = await loadDshConversationTranscript(
        reference,
        input.runtimeWork,
        input.loadTranscript
      )
      assertCurrent(version)
      snapshots.set(conversationReferenceKey(reference), snapshot)
      return snapshot
    },
    async readAssetChunk(reference, request) {
      const version = generation
      assertCurrent(version)
      const snapshot = snapshots.get(conversationReferenceKey(reference))
      if (!snapshot) throw new Error('Conversation asset is not part of the exported conversation')
      const chunk = await readConversationAssetChunk(snapshot, request, input =>
        invokeDesktopHost<WeworkConversationAssetChunk>('filesystem.readFileChunk', input)
      )
      assertCurrent(version)
      return chunk
    },
  }
  return {
    reconcile() {
      const bridge = owner.isActive() ? (window.__WEWORK_DSH_APP_BRIDGE__ ?? null) : null
      if (boundBridge !== bridge) {
        unbind?.()
        unbind = null
        boundBridge = bridge
      }
      if (bridge && !unbind) {
        let currentOwner = bridgeOwners.get(bridge)
        if (!currentOwner || currentOwner.ownershipKey !== owner.ownershipKey) {
          currentOwner = { ownershipKey: owner.ownershipKey }
          bridgeOwners.set(bridge, currentOwner)
        }
        if (exportOwner !== currentOwner) {
          generation += 1
          snapshots.clear()
          exportBridge = bridge
          exportOwner = currentOwner
        }
        unbind = bindDshConversationController(controller)
      }
    },
    retire() {
      generation += 1
      unbind?.()
      unbind = null
      boundBridge = null
      snapshots.clear()
    },
  }
}
