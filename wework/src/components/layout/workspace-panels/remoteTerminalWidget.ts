import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { RemoteTerminalClientFactory } from '@/lib/remote-terminal-socket'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from '@/lib/xterm-theme'
import { appendRuntimeTerminalContext } from '@/lib/runtime-terminal-context'
import { focusTerminalUnlessComposerFocusRequested } from '@/lib/workbenchComposerFocus'
import type { AppearanceConfig } from '@/features/appearance'
import type { GeometrySnapshot } from '@wegent/collaboration/dom-events'
import type { TFunction } from 'i18next'
import { createXtermWebLinksAddon } from './xtermLinks'
import { installXtermInputFallback, type XtermInputFallbackController } from './xtermInputFallback'
import { installXtermMacKeybindings } from './xtermMacKeybindings'
import { installXtermSelectionGuard } from './xtermSelectionGuard'
import { installXtermTextDrag } from './xtermTextDrag'
import {
  installXtermRenderRecovery,
  logXtermRenderState,
  refreshXterm,
} from './xtermRenderRecovery'

const MAX_PENDING_OUTPUT_CHUNKS = 256
const MAX_PENDING_OUTPUT_CHARACTERS = 1024 * 1024
const MAX_PENDING_INPUT_CHARACTERS = 64 * 1024
const ACK_RETRY_DELAY_MS = 1_000
const OUTPUT_GAP_REPLAY_DELAY_MS = 1_000
const OUTPUT_GAP_REPLAY_MAX_DELAY_MS = 10_000
const RECONNECT_ATTACH_RETRY_DELAY_MS = 1_000
const RECONNECT_ATTACH_RETRY_MAX_DELAY_MS = 16_000

interface RemoteTerminalIdentity {
  sessionId: string
  clientFactory: RemoteTerminalClientFactory
  showWorkbenchBackground: boolean
}

export interface RemoteTerminalPresentation {
  active: boolean
  appearance: AppearanceConfig
  t: TFunction
  taskId?: string | null
  workspacePath?: string | null
  cwd?: string | null
  title?: string | null
  onExit?: () => void
  onTitleChange?: (title: string) => void
  geometry: GeometrySnapshot | null
}

interface RemoteTerminalResource extends RemoteTerminalIdentity {
  container: HTMLDivElement
  present: (next: RemoteTerminalPresentation) => void
  dispose: () => void
}

/** An xterm widget owns one authenticated client and its ordered transport queues. */
function openRemoteTerminalWidget(
  container: HTMLDivElement,
  { sessionId, clientFactory, showWorkbenchBackground }: RemoteTerminalIdentity,
  presentation: RemoteTerminalPresentation,
  isBound: () => boolean
): RemoteTerminalResource {
  let lastSize: { rows: number; cols: number } | null = null
  let activationFrame: number | null = null
  let typographyFrame: number | null = null
  const terminalAppearance = presentation.appearance
  const terminal = new Terminal({
    allowTransparency: showWorkbenchBackground,
    cursorBlink: true,
    convertEol: true,
    fontFamily: terminalAppearance.codeFont,
    fontSize: terminalAppearance.codeFontSize,
    lineHeight: 1.2,
    scrollback: 2000,
    theme: getTerminalTheme(showWorkbenchBackground),
  })
  const fitAddon = new FitAddon()
  const webLinksAddon = createXtermWebLinksAddon()
  const client = clientFactory(sessionId)
  let disposed = false
  // Hidden tabs remain live; only a released or disconnected widget loses ownership.
  const isCurrent = () => !disposed && isBound() && container.isConnected
  let attached = false
  let hasAttachedOnce = false
  let attachGeneration = 0
  let lastConsumedSequence = 0
  let lastAcknowledgedSequence = 0
  let legacyOutput = false
  let outputFailed = false
  let exitReceived = false
  let exitReported = false
  let writingSequence: number | null = null
  let pendingOutputCharacters = 0
  let acknowledgeTimer: number | null = null
  let acknowledgementInFlight = false
  let acknowledgementGeneration = 0
  let outputGapTimer: number | null = null
  let outputReplayRequiredThroughSequence: number | null = null
  let outputRecoveryInFlight = false
  let outputRecoveryAttempts = 0
  let recoverOutputGap: () => void = () => undefined
  let flushPendingInput: () => void = () => undefined
  let reconnectGeneration = 0
  let reconnectAttachRetryTimer: number | null = null
  let reconnectAttachRetryAttempts = 0
  let attachRequest: {
    reason: 'initial' | 'reconnect'
    reconnectGeneration: number
    retryOnFailure: boolean
  } | null = null
  let activeAttachRequest: {
    reason: 'initial' | 'reconnect'
    reconnectGeneration: number
    retryOnFailure: boolean
  } | null = null
  let attachInFlight: Promise<boolean> | null = null
  let inputFlushInFlight = false
  let pendingInputCharacters = 0
  const pendingOutputs = new Map<number, { sequence: number; data: string }>()
  const pendingInputs: string[] = []

  const clearOutputGapTimer = () => {
    if (outputGapTimer === null) return
    window.clearTimeout(outputGapTimer)
    outputGapTimer = null
  }

  const hasOutputGap = () =>
    (outputReplayRequiredThroughSequence !== null &&
      lastConsumedSequence < outputReplayRequiredThroughSequence) ||
    (writingSequence === null &&
      pendingOutputs.size > 0 &&
      !pendingOutputs.has(lastConsumedSequence + 1))

  const nextOutputGapRecoveryDelay = () =>
    Math.min(
      OUTPUT_GAP_REPLAY_DELAY_MS * 2 ** Math.min(outputRecoveryAttempts, 4),
      OUTPUT_GAP_REPLAY_MAX_DELAY_MS
    )

  const scheduleOutputGapRecovery = (delay = nextOutputGapRecoveryDelay()) => {
    if (!isCurrent() || !hasAttachedOnce || outputRecoveryInFlight || !hasOutputGap()) return
    if (outputGapTimer !== null) {
      if (delay > 0) return
      clearOutputGapTimer()
    }
    outputGapTimer = window.setTimeout(() => {
      outputGapTimer = null
      if (isCurrent() && hasAttachedOnce && !outputRecoveryInFlight && hasOutputGap()) {
        recoverOutputGap()
      }
    }, delay)
  }

  const updateOutputGapRecovery = () => {
    if (hasOutputGap()) {
      scheduleOutputGapRecovery()
    } else {
      clearOutputGapTimer()
      outputRecoveryAttempts = 0
    }
  }

  const scheduleAcknowledgement = (delay = 0) => {
    if (
      !isCurrent() ||
      !attached ||
      acknowledgementInFlight ||
      lastConsumedSequence <= lastAcknowledgedSequence
    ) {
      return
    }
    if (acknowledgeTimer !== null) {
      if (delay > 0) return
      window.clearTimeout(acknowledgeTimer)
    }

    acknowledgeTimer = window.setTimeout(() => {
      acknowledgeTimer = null
      if (
        !isCurrent() ||
        !attached ||
        acknowledgementInFlight ||
        lastConsumedSequence <= lastAcknowledgedSequence
      ) {
        return
      }

      const sequence = lastConsumedSequence
      const generation = acknowledgementGeneration
      acknowledgementInFlight = true
      void client
        .ack(sequence)
        .then(() => {
          if (!isCurrent() || generation !== acknowledgementGeneration) return
          acknowledgementInFlight = false
          lastAcknowledgedSequence = Math.max(lastAcknowledgedSequence, sequence)
          scheduleAcknowledgement()
        })
        .catch(error => {
          if (!isCurrent() || generation !== acknowledgementGeneration) return
          acknowledgementInFlight = false
          console.error('Failed to acknowledge remote terminal output:', error)
          scheduleAcknowledgement(ACK_RETRY_DELAY_MS)
        })
    }, delay)
  }

  const writeTerminalOutput = (sequence: number, data: string) => {
    if (!isCurrent()) return
    writingSequence = sequence
    const writeStartedAt = performance.now()
    const context = presentation
    if (data) {
      appendRuntimeTerminalContext({
        sessionId,
        taskId: context.taskId,
        workspacePath: context.workspacePath,
        cwd: context.cwd,
        title: context.title,
        kind: 'remote',
        data,
      })
    }

    try {
      terminal.write(data, () => {
        if (!isCurrent() || writingSequence !== sequence) return
        writingSequence = null
        lastConsumedSequence = sequence
        if (
          outputReplayRequiredThroughSequence !== null &&
          lastConsumedSequence >= outputReplayRequiredThroughSequence
        ) {
          outputReplayRequiredThroughSequence = null
        }
        window.__WEWORK_PERF__?.mark('remote-terminal-write', {
          sequence,
          characters: data.length,
          durationMs: Math.round((performance.now() - writeStartedAt) * 10) / 10,
        })
        scheduleAcknowledgement()
        drainPendingOutputs()
      })
    } catch (error) {
      writingSequence = null
      console.error('Failed to write remote terminal output:', error)
    }
  }

  const drainPendingOutputs = () => {
    if (!isCurrent() || writingSequence !== null) return

    const nextSequence = lastConsumedSequence + 1
    const nextOutput = pendingOutputs.get(nextSequence)
    if (!nextOutput) {
      if (exitReceived && !exitReported && pendingOutputs.size === 0) {
        exitReported = true
        presentation.onExit?.()
        return
      }
      updateOutputGapRecovery()
      return
    }

    pendingOutputs.delete(nextSequence)
    pendingOutputCharacters -= nextOutput.data.length
    writeTerminalOutput(nextOutput.sequence, nextOutput.data)
  }

  const failLegacyOutput = () => {
    outputFailed = true
    setDetached()
    clearOutputGapTimer()
    pendingOutputs.clear()
    pendingOutputCharacters = 0
    terminal.writeln(`\r\n[${presentation.t('common:workbench.remote_terminal_legacy_overflow')}]`)
    void client
      .close()
      .catch(error => {
        console.error('Failed to close overloaded legacy terminal:', error)
      })
      .finally(() => client.dispose())
  }

  const receiveTerminalOutput = (sequence: number, data: string) => {
    if (!isCurrent() || outputFailed) return
    if (legacyOutput && data.length > MAX_PENDING_OUTPUT_CHARACTERS) {
      failLegacyOutput()
      return
    }
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      console.error('Ignored remote terminal output with invalid sequence:', sequence)
      return
    }

    if (sequence <= lastConsumedSequence) {
      scheduleAcknowledgement()
      return
    }
    if (sequence === writingSequence || pendingOutputs.has(sequence)) return

    const nextSequence = lastConsumedSequence + 1
    if (sequence === nextSequence && writingSequence === null) {
      writeTerminalOutput(sequence, data)
      return
    }

    if (
      pendingOutputs.size >= MAX_PENDING_OUTPUT_CHUNKS ||
      pendingOutputCharacters + data.length > MAX_PENDING_OUTPUT_CHARACTERS
    ) {
      if (legacyOutput) {
        failLegacyOutput()
        return
      }
      outputReplayRequiredThroughSequence = Math.max(
        outputReplayRequiredThroughSequence ?? 0,
        sequence
      )
      console.error('Remote terminal output buffer limit exceeded; requesting bounded replay.')
      scheduleOutputGapRecovery(0)
      return
    }

    pendingOutputs.set(sequence, { sequence, data })
    pendingOutputCharacters += data.length
    updateOutputGapRecovery()
  }

  let inputFallback: XtermInputFallbackController = {
    noteData: () => undefined,
    dispose: () => undefined,
  }
  const writeTerminalInput = (data: string) => {
    if (!isCurrent() || outputFailed) return
    inputFallback.noteData(data)
    if (pendingInputCharacters + data.length > MAX_PENDING_INPUT_CHARACTERS) {
      console.error('Remote terminal input buffer limit exceeded; input was discarded.')
      return
    }
    pendingInputs.push(data)
    pendingInputCharacters += data.length
    flushPendingInput()
  }
  const dataDisposable = terminal.onData(writeTerminalInput)
  const unsubscribeOutput = client.onOutput(payload => {
    if (isCurrent() && payload.session_id === sessionId && typeof payload.data === 'string') {
      legacyOutput = payload.protocol_version === 1
      receiveTerminalOutput(payload.sequence, payload.data)
    }
  })
  const titleDisposable = terminal.onTitleChange(title => {
    if (isCurrent()) presentation.onTitleChange?.(title)
  })
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(webLinksAddon)
  terminal.open(container)
  const selectionGuard = installXtermSelectionGuard({ container, terminal })
  const textDrag = installXtermTextDrag({ container, terminal })
  inputFallback = installXtermInputFallback({
    terminal,
    writeData: writeTerminalInput,
  })
  installXtermMacKeybindings({ terminal, writeData: writeTerminalInput })
  applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
  const unobserveTheme = observeTerminalTheme(theme => {
    if (!isCurrent()) return
    applyTerminalTheme(terminal, container, theme, showWorkbenchBackground)
  })

  const fitAndResize = () => {
    if (!isCurrent() || !presentation.active) return
    try {
      fitAddon.fit()
      refreshXterm(terminal)
    } catch (error) {
      console.error('Failed to resize remote terminal:', error)
      return
    }
    syncTerminalSize(error => {
      if (isCurrent()) {
        console.error('Failed to resize remote terminal:', error)
      }
    })
  }

  const syncTerminalSize = (onError: (error: unknown) => void) => {
    if (
      !isCurrent() ||
      !attached ||
      !presentation.active ||
      terminal.rows <= 0 ||
      terminal.cols <= 0
    )
      return

    if (lastSize?.rows === terminal.rows && lastSize.cols === terminal.cols) return

    lastSize = { rows: terminal.rows, cols: terminal.cols }
    void client.resize(terminal.rows, terminal.cols).catch(onError)
  }

  const setDetached = () => {
    attached = false
    acknowledgementGeneration += 1
    acknowledgementInFlight = false
    if (acknowledgeTimer !== null) {
      window.clearTimeout(acknowledgeTimer)
      acknowledgeTimer = null
    }
    lastSize = null
  }

  const clearReconnectAttachRetry = () => {
    if (reconnectAttachRetryTimer === null) return
    window.clearTimeout(reconnectAttachRetryTimer)
    reconnectAttachRetryTimer = null
  }

  const markDisconnected = () => {
    if (!isCurrent()) return
    reconnectGeneration += 1
    attachGeneration += 1
    reconnectAttachRetryAttempts = 0
    clearReconnectAttachRetry()
    setDetached()
  }

  const unsubscribeExit = client.onExit(payload => {
    if (!isCurrent() || outputFailed || payload.session_id !== sessionId) return
    exitReceived = true
    if (payload.output_complete !== false) {
      drainPendingOutputs()
      return
    }

    outputFailed = true
    reconnectGeneration += 1
    attachGeneration += 1
    clearReconnectAttachRetry()
    clearOutputGapTimer()
    setDetached()
    writingSequence = null
    pendingOutputs.clear()
    pendingOutputCharacters = 0
    outputReplayRequiredThroughSequence = null
    pendingInputs.length = 0
    pendingInputCharacters = 0
    if (!exitReported) {
      exitReported = true
      presentation.onExit?.()
    }
  })

  flushPendingInput = () => {
    if (!isCurrent() || !attached || inputFlushInFlight || pendingInputs.length === 0) return
    inputFlushInFlight = true
    let failed = false
    void (async () => {
      while (isCurrent() && attached && pendingInputs.length > 0) {
        const data = pendingInputs[0]
        try {
          await client.write(data)
        } catch (error) {
          if (isCurrent()) {
            console.error('Failed to write to remote terminal:', error)
          }
          failed = true
          break
        }
        pendingInputs.shift()
        pendingInputCharacters -= data.length
      }
    })().finally(() => {
      inputFlushInFlight = false
      if (!failed && isCurrent() && attached && pendingInputs.length > 0) {
        flushPendingInput()
      }
    })
  }

  const performAttach = async (reason: 'initial' | 'reconnect'): Promise<boolean> => {
    if (!isCurrent()) return false
    if (reason === 'reconnect') {
      setDetached()
    }
    const generation = ++attachGeneration

    try {
      if (reason === 'reconnect') {
        await client.attach(lastConsumedSequence)
      } else {
        await client.attach()
      }
    } catch (error) {
      if (!isCurrent() || generation !== attachGeneration) return false
      if (reason === 'initial') {
        console.error('Failed to attach remote terminal:', error)
        terminal.writeln('\r\n[Terminal connection failed]')
      } else {
        console.error('Failed to reattach remote terminal:', error)
      }
      return false
    }

    if (!isCurrent() || outputFailed || generation !== attachGeneration) return false
    attached = true
    hasAttachedOnce = true
    scheduleAcknowledgement()
    updateOutputGapRecovery()
    flushPendingInput()

    if (reason === 'reconnect') {
      if (!presentation.active) return true
      if (terminal.rows > 0 && terminal.cols > 0) {
        const reconnectSize = { rows: terminal.rows, cols: terminal.cols }
        lastSize = reconnectSize
        void client.resize(terminal.rows, terminal.cols).catch(error => {
          if (isCurrent()) {
            if (lastSize?.rows === reconnectSize.rows && lastSize.cols === reconnectSize.cols) {
              lastSize = null
            }
            console.error('Failed to resize remote terminal after reconnect:', error)
          }
        })
      }
      return true
    }

    requestAnimationFrame(fitAndResize)
    return true
  }

  const scheduleReconnectAttachRetry = () => {
    if (!isCurrent() || reconnectAttachRetryTimer !== null) return
    const generation = reconnectGeneration
    const delay = Math.min(
      RECONNECT_ATTACH_RETRY_DELAY_MS * 2 ** Math.min(reconnectAttachRetryAttempts, 4),
      RECONNECT_ATTACH_RETRY_MAX_DELAY_MS
    )
    reconnectAttachRetryAttempts += 1
    reconnectAttachRetryTimer = window.setTimeout(() => {
      reconnectAttachRetryTimer = null
      if (isCurrent() && generation === reconnectGeneration) {
        void attachClient('reconnect')
      }
    }, delay)
  }

  const attachClient = (
    reason: 'initial' | 'reconnect',
    retryOnFailure = reason === 'reconnect'
  ): Promise<boolean> => {
    if (!isCurrent()) return Promise.resolve(false)
    const request = { reason, reconnectGeneration, retryOnFailure }
    if (attachInFlight) {
      if (
        reason === 'reconnect' &&
        activeAttachRequest?.reconnectGeneration !== reconnectGeneration &&
        attachRequest?.reconnectGeneration !== reconnectGeneration
      ) {
        attachRequest = request
      } else if (
        reason === 'reconnect' &&
        retryOnFailure &&
        activeAttachRequest?.reconnectGeneration === reconnectGeneration
      ) {
        activeAttachRequest.retryOnFailure = true
      }
      return attachInFlight
    }
    if (reason === 'reconnect') {
      clearReconnectAttachRetry()
    }
    if (reason === 'reconnect' || attachRequest === null) {
      attachRequest = request
    }

    const run = async () => {
      let success = false
      while (isCurrent() && attachRequest !== null) {
        const requested = attachRequest
        attachRequest = null
        activeAttachRequest = requested
        success = await performAttach(requested.reason)
        activeAttachRequest = null
        if (
          requested.reason === 'reconnect' &&
          requested.reconnectGeneration === reconnectGeneration
        ) {
          if (success) {
            reconnectAttachRetryAttempts = 0
            clearReconnectAttachRetry()
          } else if (requested.retryOnFailure && attachRequest === null) {
            scheduleReconnectAttachRetry()
          }
        }
      }
      return success
    }
    const current = run()
    attachInFlight = current
    void current.finally(() => {
      if (attachInFlight === current) {
        attachInFlight = null
      }
    })
    return current
  }

  recoverOutputGap = () => {
    if (!isCurrent() || !hasAttachedOnce || outputRecoveryInFlight || !hasOutputGap()) return
    outputRecoveryInFlight = true
    window.__WEWORK_PERF__?.mark('remote-terminal-replay-request', {
      lastConsumedSequence,
      pendingChunks: pendingOutputs.size,
      pendingCharacters: pendingOutputCharacters,
      bufferLimitReached: outputReplayRequiredThroughSequence !== null,
      attempt: outputRecoveryAttempts + 1,
    })
    void attachClient('reconnect', false)
      .then(success => {
        if (!success && !attached && isCurrent()) {
          scheduleReconnectAttachRetry()
          return
        }
        if (hasOutputGap()) {
          outputRecoveryAttempts += 1
        }
      })
      .finally(() => {
        outputRecoveryInFlight = false
        if (attached) {
          updateOutputGapRecovery()
        }
      })
  }

  const removeRenderRecovery = installXtermRenderRecovery(fitAndResize)
  const unsubscribeDisconnect = client.onDisconnect(markDisconnected)
  const unsubscribeReconnect = client.onReconnect(() => {
    void attachClient('reconnect')
  })

  void attachClient('initial')

  const activate = () => {
    activationFrame = requestAnimationFrame(() => {
      activationFrame = null
      if (!isCurrent() || !presentation.active) return
      try {
        applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
        fitAddon.fit()
        refreshXterm(terminal)
        logXtermRenderState({
          active: presentation.active,
          container,
          phase: 'activation-complete',
          sessionId,
          taskId: presentation.taskId,
          terminal,
          terminalKind: 'remote',
        })
        focusTerminalUnlessComposerFocusRequested(terminal.textarea)
      } catch (error) {
        console.error('Failed to activate remote terminal:', error)
        return
      }
      syncTerminalSize(error => {
        if (isCurrent()) console.error('Failed to sync remote terminal size on activate:', error)
      })
    })
  }

  const resource: RemoteTerminalResource = {
    container,
    sessionId,
    clientFactory,
    showWorkbenchBackground,
    present: next => {
      if (!isCurrent()) return
      const previous = presentation
      presentation = next
      if (previous.appearance !== next.appearance) {
        terminal.options.fontFamily = next.appearance.codeFont
        terminal.options.fontSize = next.appearance.codeFontSize
        if (typographyFrame !== null) cancelAnimationFrame(typographyFrame)
        typographyFrame = requestAnimationFrame(() => {
          typographyFrame = null
          if (!isCurrent()) return
          try {
            fitAddon.fit()
          } catch (error) {
            console.error('Failed to resize remote terminal after typography change:', error)
          }
        })
      }
      if (previous.active !== next.active || previous.taskId !== next.taskId) {
        logXtermRenderState({
          active: next.active,
          container,
          phase: 'active-changed',
          sessionId,
          taskId: next.taskId,
          terminal,
          terminalKind: 'remote',
        })
        if (activationFrame !== null) cancelAnimationFrame(activationFrame)
        activationFrame = null
        if (next.active) activate()
      }
      if (previous.geometry !== next.geometry) fitAndResize()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      if (activationFrame !== null) cancelAnimationFrame(activationFrame)
      if (typographyFrame !== null) cancelAnimationFrame(typographyFrame)
      unobserveTheme()
      removeRenderRecovery()
      dataDisposable.dispose()
      titleDisposable.dispose()
      selectionGuard.dispose()
      textDrag.dispose()
      inputFallback.dispose()
      if (acknowledgeTimer !== null) {
        window.clearTimeout(acknowledgeTimer)
        acknowledgeTimer = null
      }
      clearOutputGapTimer()
      clearReconnectAttachRetry()
      pendingOutputs.clear()
      pendingOutputCharacters = 0
      pendingInputs.length = 0
      pendingInputCharacters = 0
      unsubscribeOutput()
      unsubscribeExit()
      unsubscribeDisconnect()
      unsubscribeReconnect()
      void client
        .close()
        .catch(() => undefined)
        .finally(() => {
          client.dispose()
        })
      terminal.dispose()
    },
  }

  logXtermRenderState({
    active: presentation.active,
    container,
    phase: 'active-changed',
    sessionId,
    taskId: presentation.taskId,
    terminal,
    terminalKind: 'remote',
  })
  if (presentation.active) activate()
  return resource
}

/** The native widget port preserves its PTY through synchronous React ref replay. */
export function createRemoteTerminalWidget() {
  let resource: RemoteTerminalResource | null = null
  let releaseTimer: number | null = null
  let binding: symbol | null = null
  return {
    attach(
      container: HTMLDivElement,
      identity: RemoteTerminalIdentity,
      presentation: RemoteTerminalPresentation
    ) {
      const owner = Symbol('remote-terminal-widget-binding')
      binding = owner
      if (releaseTimer !== null) window.clearTimeout(releaseTimer)
      releaseTimer = null
      if (
        resource &&
        (resource.container !== container ||
          resource.sessionId !== identity.sessionId ||
          resource.clientFactory !== identity.clientFactory ||
          resource.showWorkbenchBackground !== identity.showWorkbenchBackground)
      ) {
        resource.dispose()
        resource = null
      }
      if (resource) resource.present(presentation)
      else
        resource = openRemoteTerminalWidget(
          container,
          identity,
          presentation,
          () => binding !== null
        )
      return () => {
        if (binding !== owner) return
        // Revoke callbacks synchronously; same-commit reattachment takes over pending I/O.
        binding = null
        releaseTimer = window.setTimeout(() => {
          if (binding !== null) return
          releaseTimer = null
          resource?.dispose()
          resource = null
        }, 0)
      }
    },
  }
}
