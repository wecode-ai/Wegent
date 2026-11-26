import { createTelemetrySession, type TelemetrySessionInput } from '@/telemetry/telemetrySession'
import {
  startAwayImNotificationPresence,
  type PresenceUpdater,
} from '@/features/workbench/awayImNotificationPresence'
import { createWorkbenchIdleMaintenance } from '@/features/idle-tasks/workbenchIdleMaintenance'
import { createLocalAppServices } from '@/api/local/localServices'
import {
  GO_BACK_COMMAND,
  GO_FORWARD_COMMAND,
  INCREASE_FONT_SIZE_COMMAND,
  DECREASE_FONT_SIZE_COMMAND,
  RESET_FONT_SIZE_COMMAND,
  dispatchBuiltinShortcutCommand,
  shouldIgnoreWorkbenchShortcut,
  isBuiltinShortcutCommand,
  keybindingFromKeyboardEvent,
  mergeKeybindings,
  setActiveKeybindings,
  type KeybindingOverride,
} from '@/lib/keybindings'
import { getPlatform } from '@/lib/platform'
import { getWeworkDocumentTitle } from '@/lib/wework-dev-instance'
import { installMacOSInputArrowKeyGuard } from '@/lib/macosInputArrowKeyGuard'
import type { useTranslation } from '@/hooks/useTranslation'
import {
  executeDshCommand,
  getDshKeybindingDefaults,
  isDshCommandEnabled,
  subscribeDshExtensions,
} from '@/features/dsh-runtime/dshExtensions'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { Context } from '@deepseek-ai/cordis'
import { registerAppWorkbenchCommands } from './appWorkbenchCommands'
interface AppShellInput {
  telemetry?: TelemetrySessionInput
  ownershipKey: string
  dshContext: Context | null
  t: ReturnType<typeof useTranslation>['t']
  isDesktop: boolean
  isElectron: boolean
  isMainWindow: boolean
  isPopoutWindow: boolean
  isLoading: boolean
  path: string
  assistantPreferenceFailed?: boolean
  idleMaintenanceEligible: boolean
  imPresence: { enabled: boolean; scopeKey: string; updatePresence?: PresenceUpdater }
}
/** Window command registration, local keybinding reads and startup visibility share the app owner. */
export function createAppShellSession() {
  const telemetry = createTelemetrySession()
  let input: AppShellInput | null = null
  let snapshot = { ownershipKey: '', workbenchStartupReady: false, bindings: mergeKeybindings([]) }
  const readiness = new Map<string, boolean>()
  const listeners = new Set<() => void>()
  let overrides: KeybindingOverride[] = []
  let generation = 0
  let keybindingRequest = 0
  let releaseCommands: (() => void) | undefined
  let releaseExtensions: (() => void) | undefined
  let releaseArrowGuard: (() => void) | undefined
  let presenceOwner: { scopeKey: string; updatePresence: PresenceUpdater; stop(): void } | undefined
  let started = false
  let idleMaintenance: ReturnType<typeof createWorkbenchIdleMaintenance> | undefined
  const publish = (change: Partial<typeof snapshot>) => {
    if (!listeners.size) return
    snapshot = { ...snapshot, ...change }
    listeners.forEach(listener => listener())
  }
  const synchronizeIdleMaintenance = () => {
    if (input?.idleMaintenanceEligible && listeners.size) {
      idleMaintenance ??= createWorkbenchIdleMaintenance()
      idleMaintenance.setReady(
        snapshot.ownershipKey === input.ownershipKey && snapshot.workbenchStartupReady
      )
    } else {
      idleMaintenance?.dispose()
      idleMaintenance = undefined
    }
  }
  const synchronizeAwayPresence = () => {
    const current = input?.imPresence
    if (!current?.enabled || !current.updatePresence) {
      presenceOwner?.stop()
      presenceOwner = undefined
      return
    }
    if (
      presenceOwner?.scopeKey === current.scopeKey &&
      presenceOwner.updatePresence === current.updatePresence
    )
      return
    presenceOwner?.stop()
    presenceOwner = {
      scopeKey: current.scopeKey,
      updatePresence: current.updatePresence,
      stop: startAwayImNotificationPresence(current.scopeKey, current.updatePresence),
    }
  }
  const applyKeybindings = () => {
    publish({ bindings: setActiveKeybindings(overrides, getDshKeybindingDefaults(getPlatform())) })
  }
  const loadKeybindings = async () => {
    if (!input?.isDesktop || input.isPopoutWindow || !started) return
    const ownerGeneration = generation
    const request = ++keybindingRequest
    try {
      const response = await createLocalAppServices().runtimeWorkApi?.getKeybindings()
      if (!started || generation !== ownerGeneration || keybindingRequest !== request) return
      overrides = response?.keybindings ?? []
      applyKeybindings()
    } catch (error) {
      if (started && generation === ownerGeneration)
        console.error('[Wework] Failed to load keybindings:', error)
    }
  }
  const executeShortcutCommand = (command: string, source: string) => {
    const ownerGeneration = generation
    void executeDshCommand(command, undefined, { source })
      .then(executed => {
        if (!executed && started && generation === ownerGeneration)
          dispatchBuiltinShortcutCommand(command)
      })
      .catch(error => {
        console.error(`[Wework] Failed to execute command "${command}":`, error)
      })
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const increaseFontSizeKey = snapshot.bindings[INCREASE_FONT_SIZE_COMMAND]
    const decreaseFontSizeKey = snapshot.bindings[DECREASE_FONT_SIZE_COMMAND]
    const resetFontSizeKey = snapshot.bindings[RESET_FONT_SIZE_COMMAND]
    const eventKey = keybindingFromKeyboardEvent(event)
    const matchesFontSizeShortcut =
      eventKey === increaseFontSizeKey ||
      eventKey === decreaseFontSizeKey ||
      eventKey === resetFontSizeKey
    // The page zoom guard prevents WebView zoom before this window-level
    // handler runs. Keep application font-size shortcuts actionable.
    if (event.defaultPrevented && !matchesFontSizeShortcut) return
    const command = Object.entries(snapshot.bindings).find(
      ([, key]) => key !== null && key === eventKey
    )?.[0]
    if (!command) return
    const executable = isBuiltinShortcutCommand(command) || isDshCommandEnabled(command)
    if (!executable) return
    if (shouldIgnoreWorkbenchShortcut(event)) return
    event.preventDefault()
    event.stopPropagation()
    executeShortcutCommand(command, 'keybinding')
  }

  const handleMouseUp = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    if (snapshot.bindings[GO_BACK_COMMAND] && event.button === 3) {
      event.preventDefault()
      executeShortcutCommand(GO_BACK_COMMAND, 'mouse')
      return
    }
    if (snapshot.bindings[GO_FORWARD_COMMAND] && event.button === 4) {
      event.preventDefault()
      executeShortcutCommand(GO_FORWARD_COMMAND, 'mouse')
    }
  }

  return {
    getSnapshot: () => snapshot,
    handleKeyDown,
    handleMouseUp,
    loadKeybindings,
    setWorkbenchStartupReady(ownershipKey: string, ready: boolean) {
      readiness.set(ownershipKey, ready)
      if (snapshot.ownershipKey === ownershipKey && snapshot.workbenchStartupReady !== ready)
        publish({ workbenchStartupReady: ready })
      synchronizeIdleMaintenance()
    },
    subscribe(listener: () => void, next: AppShellInput) {
      const previous = input
      input = next
      listeners.add(listener)
      if (next.telemetry) telemetry.update(next.telemetry)
      const ownershipChanged = snapshot.ownershipKey !== next.ownershipKey
      if (ownershipChanged) {
        idleMaintenance?.dispose()
        idleMaintenance = undefined
        generation += 1
        publish({
          ownershipKey: next.ownershipKey,
          workbenchStartupReady: readiness.get(next.ownershipKey) ?? false,
        })
      }
      if (!started) {
        started = true
        document.title = getWeworkDocumentTitle()
        releaseArrowGuard = installMacOSInputArrowKeyGuard()
      }
      if (
        !previous ||
        previous.dshContext !== next.dshContext ||
        previous.t !== next.t ||
        previous.isDesktop !== next.isDesktop ||
        previous.isElectron !== next.isElectron ||
        previous.isMainWindow !== next.isMainWindow ||
        previous.isPopoutWindow !== next.isPopoutWindow ||
        !releaseCommands
      ) {
        releaseCommands?.()
        releaseCommands = next.dshContext
          ? registerAppWorkbenchCommands(next.dshContext, next.t, next)
          : undefined
      }
      if (next.isDesktop && !next.isPopoutWindow && !releaseExtensions) {
        releaseExtensions = subscribeDshExtensions(applyKeybindings)
        void loadKeybindings()
      } else if (ownershipChanged && next.isDesktop && !next.isPopoutWindow) {
        void loadKeybindings()
      }
      const startupRouteReady =
        next.assistantPreferenceFailed ||
        ['/login', '/login/oidc', '/auth/wework/authorize'].includes(next.path)
      if (
        startupRouteReady &&
        !next.isLoading &&
        next.isMainWindow &&
        (!previous ||
          previous.path !== next.path ||
          previous.assistantPreferenceFailed !== next.assistantPreferenceFailed ||
          previous.isLoading !== next.isLoading ||
          previous.isMainWindow !== next.isMainWindow)
      ) {
        void invokeDesktopHost<void>('renderer.startupReady').catch(error =>
          console.error('[Wework] Failed to reveal the startup route', error)
        )
      }
      synchronizeIdleMaintenance()
      synchronizeAwayPresence()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          started = false
          telemetry.stop()
          presenceOwner?.stop()
          presenceOwner = undefined
          idleMaintenance?.dispose()
          idleMaintenance = undefined
          generation += 1
          releaseCommands?.()
          releaseCommands = undefined
          releaseExtensions?.()
          releaseExtensions = undefined
          releaseArrowGuard?.()
          releaseArrowGuard = undefined
        })
      }
    },
  }
}
