import { beforeEach, describe, expect, test } from 'vitest'
import { APP_PREFERENCES_CHANGED_EVENT, defaultAppPreferences } from '@/tauri/appPreferences'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  appendRuntimeTerminalContext,
  readRuntimeTerminalAdditionalContext,
  resetRuntimeTerminalContextForTests,
} from './runtime-terminal-context'

describe('runtime terminal context', () => {
  beforeEach(() => {
    resetRuntimeTerminalContextForTests()
    window.dispatchEvent(
      new CustomEvent(APP_PREFERENCES_CHANGED_EVENT, {
        detail: { ...defaultAppPreferences, terminalContextInjectionEnabled: true },
      })
    )
  })

  test('captures sanitized terminal output for the matching workspace', () => {
    const workspacePath = `/tmp/runtime-terminal-context-${Date.now()}`
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      workspacePath,
      taskId: 'task-1',
    }

    appendRuntimeTerminalContext({
      sessionId: `session-${Date.now()}`,
      workspacePath,
      cwd: workspacePath,
      title: 'Wegent Terminal',
      kind: 'local',
      data: '\x1b[31mpnpm test\x1b[0m\r\nfailed test output',
    })

    const context = readRuntimeTerminalAdditionalContext(address)

    expect(context).toBeDefined()
    expect(context?.['wework.terminal.current']).toEqual(
      expect.objectContaining({ kind: 'application' })
    )
    expect(context?.['wework.terminal.current'].value).toContain('kind: local')
    expect(context?.['wework.terminal.current'].value).toContain('title: Wegent Terminal')
    expect(context?.['wework.terminal.current'].value).toContain(`cwd: ${workspacePath}`)
    expect(context?.['wework.terminal.current'].value).toContain('pnpm test\nfailed test output')
    expect(context?.['wework.terminal.current'].value).not.toContain('\x1b')
  })

  test('returns no context when no terminal output matches the address', () => {
    appendRuntimeTerminalContext({
      sessionId: `session-mismatch-${Date.now()}`,
      workspacePath: `/tmp/runtime-terminal-context-source-${Date.now()}`,
      kind: 'local',
      data: 'zsh: command not found: a',
    })

    const context = readRuntimeTerminalAdditionalContext({
      deviceId: 'device-1',
      workspacePath: `/tmp/runtime-terminal-context-missing-${Date.now()}`,
      taskId: 'task-1',
    })

    expect(context).toBeUndefined()
  })

  test('keeps injected terminal context compact by default', () => {
    const workspacePath = `/tmp/runtime-terminal-context-compact-${Date.now()}`
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      workspacePath,
      taskId: 'task-1',
    }
    const oldOutput = 'old-output-should-be-truncated'
    const recentOutput = 'recent-output-should-remain'

    for (let index = 0; index < 12; index += 1) {
      appendRuntimeTerminalContext({
        sessionId: 'session-compact',
        workspacePath,
        kind: 'local',
        data: `${index === 0 ? oldOutput : `chunk-${index}`} ${'x'.repeat(520)}\n`,
      })
    }
    appendRuntimeTerminalContext({
      sessionId: 'session-compact',
      workspacePath,
      kind: 'local',
      data: `${recentOutput}\n`,
    })

    const context = readRuntimeTerminalAdditionalContext(address)
    const value = context?.['wework.terminal.current'].value ?? ''

    expect(value.length).toBeLessThanOrEqual(2300)
    expect(value).toContain(recentOutput)
    expect(value).toContain('truncated: true')
    expect(value).not.toContain(oldOutput)
  })

  test('limits injected terminal output to the most recent 80 lines', () => {
    const workspacePath = `/tmp/runtime-terminal-context-lines-${Date.now()}`
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      workspacePath,
      taskId: 'task-1',
    }
    const firstOutput = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join('\n')
    const secondOutput = Array.from({ length: 50 }, (_, index) => `line-${index + 51}`).join('\n')

    appendRuntimeTerminalContext({
      sessionId: 'session-lines',
      workspacePath,
      kind: 'local',
      data: `${firstOutput}\n`,
    })
    appendRuntimeTerminalContext({
      sessionId: 'session-lines',
      workspacePath,
      kind: 'local',
      data: secondOutput,
    })

    const context = readRuntimeTerminalAdditionalContext(address)
    const value = context?.['wework.terminal.current'].value ?? ''

    expect(value).toContain('line-100')
    expect(value).toContain('line-21')
    expect(value).not.toContain('line-20')
  })

  test('returns no context when no terminal output has been captured', () => {
    const context = readRuntimeTerminalAdditionalContext({
      deviceId: 'device-1',
      workspacePath: `/tmp/runtime-terminal-context-empty-${Date.now()}`,
      taskId: 'task-1',
    })

    expect(context).toBeUndefined()
  })

  test('returns no context when terminal context injection is disabled', () => {
    const workspacePath = `/tmp/runtime-terminal-context-disabled-${Date.now()}`
    appendRuntimeTerminalContext({
      sessionId: `session-disabled-${Date.now()}`,
      workspacePath,
      kind: 'local',
      data: 'terminal output',
    })

    window.dispatchEvent(
      new CustomEvent(APP_PREFERENCES_CHANGED_EVENT, {
        detail: { ...defaultAppPreferences, terminalContextInjectionEnabled: false },
      })
    )

    const context = readRuntimeTerminalAdditionalContext({
      deviceId: 'device-1',
      workspacePath,
      taskId: 'task-1',
    })

    expect(context).toBeUndefined()
  })
})
