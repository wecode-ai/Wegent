import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import type {
  RemoteTerminalClient,
  RemoteTerminalClientFactory,
} from '@/lib/remote-terminal-socket'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from '@/lib/xterm-theme'
import { appendRuntimeTerminalContext } from '@/lib/runtime-terminal-context'
import { focusTerminalUnlessComposerFocusRequested } from '@/lib/workbenchComposerFocus'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
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

interface RemoteTerminalProps {
  sessionId: string
  clientFactory: RemoteTerminalClientFactory
  active: boolean
  taskId?: string | null
  workspacePath?: string | null
  cwd?: string | null
  title?: string | null
  onExit?: () => void
  onTitleChange?: (title: string) => void
  testIdsEnabled?: boolean
  showWorkbenchBackground?: boolean
}

interface RemoteTerminalResource {
  sessionId: string
  clientFactory: RemoteTerminalClientFactory
  showWorkbenchBackground: boolean
  dispose: () => void
}

function matchesRemoteTerminalResource(
  resource: RemoteTerminalResource,
  sessionId: string,
  clientFactory: RemoteTerminalClientFactory,
  showWorkbenchBackground: boolean
): boolean {
  return (
    resource.sessionId === sessionId &&
    resource.clientFactory === clientFactory &&
    resource.showWorkbenchBackground === showWorkbenchBackground
  )
}

export function RemoteTerminal({
  sessionId,
  clientFactory,
  active,
  taskId,
  workspacePath,
  cwd,
  title,
  onExit,
  onTitleChange,
  testIdsEnabled = true,
  showWorkbenchBackground = false,
}: RemoteTerminalProps) {
  const { t } = useTranslation()
  const translateRef = useRef(t)
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const attachedClientRef = useRef<RemoteTerminalClient | null>(null)
  const activeRef = useRef(active)
  const contextRef = useRef({ taskId, workspacePath, cwd, title })
  const onExitRef = useRef(onExit)
  const onTitleChangeRef = useRef(onTitleChange)
  const lastSizeRef = useRef<{ rows: number; cols: number } | null>(null)
  const appearanceRef = useRef(appearance)
  const resourceRef = useRef<RemoteTerminalResource | null>(null)
  const cleanupTimerRef = useRef<number | null>(null)

  useEffect(() => {
    translateRef.current = t
  }, [t])

  useEffect(() => {
    appearanceRef.current = appearance
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal) return

    terminal.options.fontFamily = appearance.codeFont
    terminal.options.fontSize = appearance.codeFontSize
    requestAnimationFrame(() => {
      try {
        fitAddon?.fit()
      } catch (error) {
        console.error('Failed to resize remote terminal after typography change:', error)
      }
    })
  }, [appearance])

  useEffect(() => {
    activeRef.current = active
    const container = containerRef.current
    if (!container) return
    logXtermRenderState({
      active,
      container,
      phase: 'active-changed',
      sessionId,
      taskId,
      terminal: terminalRef.current,
      terminalKind: 'remote',
    })
  }, [active, sessionId, taskId])

  useEffect(() => {
    contextRef.current = { taskId, workspacePath, cwd, title }
  }, [cwd, taskId, title, workspacePath])

  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
    }
    // StrictMode replays effects in development. Keep the live socket and xterm
    // through that replay so initial PTY output cannot land on a discarded client.
    const currentResource = resourceRef.current
    if (
      currentResource &&
      matchesRemoteTerminalResource(
        currentResource,
        sessionId,
        clientFactory,
        showWorkbenchBackground
      )
    ) {
      return () => {
        cleanupTimerRef.current = window.setTimeout(currentResource.dispose, 0)
      }
    }
    currentResource?.dispose()
    lastSizeRef.current = null

    const terminalAppearance = appearanceRef.current
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
      if (disposed || !hasAttachedOnce || outputRecoveryInFlight || !hasOutputGap()) return
      if (outputGapTimer !== null) {
        if (delay > 0) return
        clearOutputGapTimer()
      }
      outputGapTimer = window.setTimeout(() => {
        outputGapTimer = null
        if (!disposed && hasAttachedOnce && !outputRecoveryInFlight && hasOutputGap()) {
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
        disposed ||
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
          disposed ||
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
            if (disposed || generation !== acknowledgementGeneration) return
            acknowledgementInFlight = false
            lastAcknowledgedSequence = Math.max(lastAcknowledgedSequence, sequence)
            scheduleAcknowledgement()
          })
          .catch(error => {
            if (disposed || generation !== acknowledgementGeneration) return
            acknowledgementInFlight = false
            console.error('Failed to acknowledge remote terminal output:', error)
            scheduleAcknowledgement(ACK_RETRY_DELAY_MS)
          })
      }, delay)
    }

    const writeTerminalOutput = (sequence: number, data: string) => {
      if (disposed) return
      writingSequence = sequence
      const writeStartedAt = performance.now()
      const context = contextRef.current
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
          if (disposed || writingSequence !== sequence) return
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
      if (disposed || writingSequence !== null) return

      const nextSequence = lastConsumedSequence + 1
      const nextOutput = pendingOutputs.get(nextSequence)
      if (!nextOutput) {
        if (exitReceived && !exitReported && pendingOutputs.size === 0) {
          exitReported = true
          onExitRef.current?.()
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
      terminal.writeln(
        `\r\n[${translateRef.current('common:workbench.remote_terminal_legacy_overflow')}]`
      )
      void client
        .close()
        .catch(error => {
          console.error('Failed to close overloaded legacy terminal:', error)
        })
        .finally(() => client.dispose())
    }

    const receiveTerminalOutput = (sequence: number, data: string) => {
      if (outputFailed) return
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
      if (outputFailed) return
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
      if (!disposed && payload.session_id === sessionId && typeof payload.data === 'string') {
        legacyOutput = payload.protocol_version === 1
        receiveTerminalOutput(payload.sequence, payload.data)
      }
    })
    const titleDisposable = terminal.onTitleChange(title => {
      onTitleChangeRef.current?.(title)
    })
    const unsubscribeExit = client.onExit(payload => {
      if (!disposed && !outputFailed && payload.session_id === sessionId) {
        exitReceived = true
        drainPendingOutputs()
      }
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
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
    const unobserveTheme = observeTerminalTheme(theme => {
      applyTerminalTheme(terminal, container, theme, showWorkbenchBackground)
    })

    const fitAndResize = () => {
      if (disposed || !activeRef.current || !container.isConnected) return
      try {
        fitAddon.fit()
        refreshXterm(terminal)
      } catch (error) {
        console.error('Failed to resize remote terminal:', error)
        return
      }
      syncTerminalSize(error => {
        if (!disposed) {
          console.error('Failed to resize remote terminal:', error)
        }
      })
    }

    const syncTerminalSize = (onError: (error: unknown) => void) => {
      if (!attached || !activeRef.current || terminal.rows <= 0 || terminal.cols <= 0) return

      const lastSize = lastSizeRef.current
      if (lastSize?.rows === terminal.rows && lastSize.cols === terminal.cols) return

      lastSizeRef.current = { rows: terminal.rows, cols: terminal.cols }
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
      lastSizeRef.current = null
      if (attachedClientRef.current === client) {
        attachedClientRef.current = null
      }
    }

    const clearReconnectAttachRetry = () => {
      if (reconnectAttachRetryTimer === null) return
      window.clearTimeout(reconnectAttachRetryTimer)
      reconnectAttachRetryTimer = null
    }

    const markDisconnected = () => {
      reconnectGeneration += 1
      attachGeneration += 1
      reconnectAttachRetryAttempts = 0
      clearReconnectAttachRetry()
      setDetached()
    }

    flushPendingInput = () => {
      if (disposed || !attached || inputFlushInFlight || pendingInputs.length === 0) return
      inputFlushInFlight = true
      let failed = false
      void (async () => {
        while (!disposed && attached && pendingInputs.length > 0) {
          const data = pendingInputs[0]
          try {
            await client.write(data)
          } catch (error) {
            if (!disposed) {
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
        if (!failed && !disposed && attached && pendingInputs.length > 0) {
          flushPendingInput()
        }
      })
    }

    const performAttach = async (reason: 'initial' | 'reconnect'): Promise<boolean> => {
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
        if (disposed || generation !== attachGeneration) return false
        if (reason === 'initial') {
          console.error('Failed to attach remote terminal:', error)
          terminal.writeln('\r\n[Terminal connection failed]')
        } else {
          console.error('Failed to reattach remote terminal:', error)
        }
        return false
      }

      if (disposed || outputFailed || generation !== attachGeneration) return false
      attached = true
      hasAttachedOnce = true
      attachedClientRef.current = client
      scheduleAcknowledgement()
      updateOutputGapRecovery()
      flushPendingInput()

      if (reason === 'reconnect') {
        if (!activeRef.current) return true
        if (terminal.rows > 0 && terminal.cols > 0) {
          const reconnectSize = { rows: terminal.rows, cols: terminal.cols }
          lastSizeRef.current = reconnectSize
          void client.resize(terminal.rows, terminal.cols).catch(error => {
            if (!disposed) {
              if (
                lastSizeRef.current?.rows === reconnectSize.rows &&
                lastSizeRef.current.cols === reconnectSize.cols
              ) {
                lastSizeRef.current = null
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
      if (disposed || reconnectAttachRetryTimer !== null) return
      const generation = reconnectGeneration
      const delay = Math.min(
        RECONNECT_ATTACH_RETRY_DELAY_MS * 2 ** Math.min(reconnectAttachRetryAttempts, 4),
        RECONNECT_ATTACH_RETRY_MAX_DELAY_MS
      )
      reconnectAttachRetryAttempts += 1
      reconnectAttachRetryTimer = window.setTimeout(() => {
        reconnectAttachRetryTimer = null
        if (!disposed && generation === reconnectGeneration) {
          void attachClient('reconnect')
        }
      }, delay)
    }

    const attachClient = (
      reason: 'initial' | 'reconnect',
      retryOnFailure = reason === 'reconnect'
    ): Promise<boolean> => {
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
        while (!disposed && attachRequest !== null) {
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
      if (disposed || !hasAttachedOnce || outputRecoveryInFlight || !hasOutputGap()) return
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
          if (!success && !attached && !disposed) {
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

    const resizeObserver = new ResizeObserver(fitAndResize)
    resizeObserver.observe(container)
    const removeRenderRecovery = installXtermRenderRecovery(fitAndResize)
    const unsubscribeDisconnect = client.onDisconnect(markDisconnected)
    const unsubscribeReconnect = client.onReconnect(() => {
      void attachClient('reconnect')
    })

    void attachClient('initial')

    const resource: RemoteTerminalResource = {
      sessionId,
      clientFactory,
      showWorkbenchBackground,
      dispose: () => {
        if (disposed) return
        disposed = true
        unobserveTheme()
        removeRenderRecovery()
        resizeObserver.disconnect()
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
        if (resourceRef.current === resource) {
          terminalRef.current = null
          fitAddonRef.current = null
          attachedClientRef.current = null
          resourceRef.current = null
        }
      },
    }
    resourceRef.current = resource

    return () => {
      cleanupTimerRef.current = window.setTimeout(resource.dispose, 0)
    }
  }, [clientFactory, sessionId, showWorkbenchBackground])

  useEffect(() => {
    if (!active) return

    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current
      const fitAddon = fitAddonRef.current
      const attachedClient = attachedClientRef.current
      const container = containerRef.current
      if (!terminal || !fitAddon || !container) return

      try {
        applyTerminalTheme(terminal, container, getTerminalTheme(), showWorkbenchBackground)
        fitAddon.fit()
        refreshXterm(terminal)
        logXtermRenderState({
          active,
          container,
          phase: 'activation-complete',
          sessionId,
          taskId,
          terminal,
          terminalKind: 'remote',
        })
        focusTerminalUnlessComposerFocusRequested(terminal.textarea)
      } catch (error) {
        console.error('Failed to activate remote terminal:', error)
        return
      }
      if (!attachedClient) return
      if (terminal.rows <= 0 || terminal.cols <= 0) return

      const lastSize = lastSizeRef.current
      if (lastSize?.rows === terminal.rows && lastSize.cols === terminal.cols) return

      lastSizeRef.current = { rows: terminal.rows, cols: terminal.cols }
      void attachedClient.resize(terminal.rows, terminal.cols).catch(error => {
        console.error('Failed to sync remote terminal size on activate:', error)
      })
    })

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [active, sessionId, showWorkbenchBackground, taskId])

  return (
    <div
      data-testid={testIdsEnabled ? 'remote-terminal' : undefined}
      className={`h-full min-h-0 w-full flex-1 overflow-hidden px-2 pb-4 pt-2 ${
        showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
      }`}
      hidden={!active}
    >
      <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" />
    </div>
  )
}
