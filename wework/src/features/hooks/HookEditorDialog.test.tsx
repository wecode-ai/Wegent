import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { HookEditorDialog } from './HookEditorDialog'
import type { HookEventName, ResolvedHookPlugin } from './hooksTypes'

describe('HookEditorDialog lifecycle events', () => {
  test.each<HookEventName>(['TurnStarted', 'TurnCompleted', 'ExecutionCompleted'])(
    '%s always saves as asynchronous with a status matcher',
    async eventName => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      render(<HookEditorDialog onSave={onSave} onClose={vi.fn()} />)
      fireEvent.change(screen.getByTestId('hook-editor-id'), { target: { value: 'logger' } })
      fireEvent.change(screen.getByTestId('hook-editor-name'), { target: { value: 'Logger' } })
      fireEvent.change(screen.getByTestId('hook-editor-command'), {
        target: { value: 'record-turn' },
      })
      fireEvent.change(screen.getByTestId('hook-editor-event'), { target: { value: eventName } })
      expect(screen.getByLabelText('状态匹配表达式')).toHaveValue('.*')
      expect(screen.getByTestId('hook-editor-async')).toBeChecked()
      expect(screen.getByTestId('hook-editor-async')).toBeDisabled()
      fireEvent.click(screen.getByTestId('hook-editor-save'))
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
      expect(onSave.mock.calls[0][0].hooks).toEqual({
        [eventName]: [
          {
            matcher: '.*',
            hooks: [{ type: 'command', command: 'record-turn', timeout: 10, async: true }],
          },
        ],
      })
    }
  )

  test('editing preserves all other handlers, platform commands and subscriptions', async () => {
    const command = {
      type: 'command' as const,
      command: 'before',
      commands: { 'macos-aarch64': './bin/record' },
      timeout: 10,
      async: false,
    }
    const plugin: ResolvedHookPlugin = {
      manifest: {
        schemaVersion: 1,
        id: 'logger',
        name: 'Logger',
        description: '',
        version: '1',
        subscriptions: ['codex_rollout'],
      },
      enabled: true,
      source: 'user',
      installPath: '/hooks/logger',
      health: 'ready',
      policy: { canDisable: true, canEdit: true, canDelete: true },
      recentRuns: [],
      handlers: [
        { id: 'post-tool-use-0-0', eventName: 'PostToolUse', matcher: '^Edit$', config: command },
        {
          id: 'turn-started-0-0',
          eventName: 'TurnStarted',
          matcher: '.*',
          config: { ...command, command: 'start' },
        },
        {
          id: 'turn-completed-0-0',
          eventName: 'TurnCompleted',
          matcher: '.*',
          config: { ...command, command: 'end' },
        },
      ],
    }
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<HookEditorDialog plugin={plugin} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('hook-editor-command'), { target: { value: 'after' } })
    fireEvent.click(screen.getByTestId('hook-editor-save'))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const draft = onSave.mock.calls[0][0]
    expect(draft.manifest).toEqual(plugin.manifest)
    expect(draft.hooks.PostToolUse[0].hooks[0]).toEqual({ ...command, command: 'after' })
    expect(draft.hooks.TurnStarted[0].hooks[0]).toEqual(plugin.handlers[1].config)
    expect(draft.hooks.TurnCompleted[0].hooks[0]).toEqual(plugin.handlers[2].config)
  })
})
