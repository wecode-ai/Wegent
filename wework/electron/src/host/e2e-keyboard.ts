import { createE2ENativeTextCommit } from './e2e-native-text-commit.js'
import { randomUUID } from 'node:crypto'
import { e2eErrorLog } from './e2e-error-log.js'
import type { KeyboardInputEvent, WebContents } from 'electron'
import { HostCapabilityError } from './capability-router.js'

const KEYS: Record<string, string> = {
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Space: 'Space',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  A: 'A',
  B: 'B',
  C: 'C',
  F: 'F',
  M: 'M',
  R: 'R',
  S: 'S',
  T: 'T',
  W: 'W',
  x: 'x',
  z: 'Z',
}

const MODIFIERS: Record<string, 'shift' | 'control' | 'alt' | 'meta'> = {
  Shift: 'shift',
  Control: 'control',
  Alt: 'alt',
  Meta: 'meta',
}

export type E2EKeyPhase = 'press' | 'down' | 'up'

function requireE2EControl(environment: NodeJS.ProcessEnv) {
  if (!environment.WEWORK_E2E_CONTROL_URL || environment.VITE_WEWORK_E2E !== 'true') {
    throw new HostCapabilityError('e2e_control_required', 'An isolated E2E controller is required')
  }
}

function requireAvailableContents(contents: WebContents) {
  if (contents.isDestroyed()) {
    throw new HostCapabilityError('e2e_view_unavailable', 'Verification view is unavailable')
  }
}

async function focusInputContents(contents: WebContents, focusWindow: () => void | Promise<void>) {
  // The renderer may already have focused an exact editor. Re-activating
  // its window here can replace that focus before native input is delivered.
  if (contents.isFocused()) return
  await focusWindow()
  requireAvailableContents(contents)
  contents.focus()
}

export async function sendE2EKey(
  contents: WebContents,
  key: string,
  focusWindow: () => void | Promise<void>,
  environment: NodeJS.ProcessEnv = process.env,
  phase: E2EKeyPhase = 'press',
  focus = true
) {
  requireE2EControl(environment)
  const parts = key.split('+')
  const mainKey = parts.pop() ?? ''
  const keyCode = Object.hasOwn(KEYS, mainKey) ? KEYS[mainKey] : undefined
  if (!keyCode || parts.some(part => !Object.hasOwn(MODIFIERS, part))) {
    throw new HostCapabilityError('e2e_invalid_key', 'Unsupported verification key')
  }
  requireAvailableContents(contents)
  const modifiers: KeyboardInputEvent['modifiers'] = parts.map(part => MODIFIERS[part])
  if (focus) {
    await focusInputContents(contents, focusWindow)
  }
  if (phase !== 'up') {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  }
  // Chromium activates native buttons on Enter's character event.
  const character =
    mainKey === 'Space' ? ' ' : mainKey === 'Enter' ? '\r' : mainKey.length === 1 ? mainKey : null
  if (phase === 'press' && character && parts.every(part => part === 'Shift')) {
    contents.sendInputEvent({ type: 'char', keyCode: character, modifiers })
  }
  if (phase !== 'down') {
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  return { backend: 'electron-send-input-event', key, phase }
}

export async function sendE2EText(
  contents: WebContents,
  text: string,
  focusWindow: () => void | Promise<void>,
  environment: NodeJS.ProcessEnv = process.env
) {
  requireE2EControl(environment)
  requireAvailableContents(contents)
  await focusInputContents(contents, focusWindow)
  // Chromium's insertText truncates multiline text in structured editors.
  // Keep native Enter events, but avoid a renderer/host round trip per line.
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const batchId = randomUUID()
  const startedAt = performance.now()
  const timing = {
    completedLines: 0,
    enterCommitCount: 0,
    enterCommitWaitMs: 0,
    commitSetupMs: 0,
    commitCleanupMs: 0,
    insertTextMs: 0,
    keyDispatchMs: 0,
  }
  const record = (type: string) =>
    e2eErrorLog.record('main', type, 'info', {
      batchId,
      webContentsId: contents.id,
      lineCount: lines.length,
      textLength: text.length,
      elapsedMs: performance.now() - startedAt,
      ...timing,
    })
  let commit: Awaited<ReturnType<typeof createE2ENativeTextCommit>> | undefined
  let failure: { error: unknown } | undefined
  record('native-text-started')
  try {
    if (lines.length > 1) {
      const setupAt = performance.now()
      try {
        commit = await createE2ENativeTextCommit(contents, batchId)
      } finally {
        timing.commitSetupMs += performance.now() - setupAt
      }
    }
    for (const [index, line] of lines.entries()) {
      requireAvailableContents(contents)
      if (index > 0) {
        const startedAt = performance.now()
        try {
          await sendE2EKey(contents, 'Enter', focusWindow, environment, 'press', false)
        } finally {
          timing.keyDispatchMs += performance.now() - startedAt
        }
        // Observe the target editor's trusted key-up after its native transaction.
        const commitAt = performance.now()
        try {
          await commit!.wait(index)
          timing.enterCommitCount += 1
        } finally {
          timing.enterCommitWaitMs += performance.now() - commitAt
        }
      }
      if (line || lines.length === 1) {
        const startedAt = performance.now()
        try {
          await contents.insertText(line)
        } finally {
          timing.insertTextMs += performance.now() - startedAt
        }
      }
      timing.completedLines = index + 1
      record('native-text-progress')
    }
  } catch (error) {
    failure = { error }
  }
  const cleanupAt = performance.now()
  try {
    if (commit && !contents.isDestroyed()) await commit.dispose()
  } catch (error) {
    e2eErrorLog.record('main', 'native-text-cleanup-failed', 'error', {
      batchId,
      message: error instanceof Error ? error.message : String(error),
    })
    failure ??= { error }
  } finally {
    timing.commitCleanupMs += performance.now() - cleanupAt
    record('native-text-stopped')
  }
  if (failure) throw failure.error
  return { backend: 'electron-insert-text', textLength: text.length }
}
