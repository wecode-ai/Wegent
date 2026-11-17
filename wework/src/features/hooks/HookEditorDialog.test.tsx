import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { HookEditorDialog } from './HookEditorDialog'
import type { ResolvedHookPlugin } from './hooksTypes'

const plugin: ResolvedHookPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'reporter',
    name: 'Reporter',
    description: '',
    version: '1.0.0',
    subscriptions: ['codex_rollout'],
  },
  enabled: true,
  source: 'user',
  installPath: '/hooks/reporter',
  policy: { canDisable: true, canEdit: true, canDelete: true },
  health: 'ready',
  handlers: [
    {
      id: 'post-tool-use-0-0',
      eventName: 'PostToolUse',
      matcher: '^apply_patch$',
      config: { type: 'command', command: 'report-edit', timeout: 10, async: false },
    },
    {
      id: 'post-tool-use-0-1',
      eventName: 'PostToolUse',
      matcher: '^apply_patch$',
      config: { type: 'command', command: 'record-edit', timeout: 5, async: true },
    },
    {
      id: 'turn-completed-0-0',
      eventName: 'TurnCompleted',
      matcher: '^completed$',
      config: { type: 'command', command: 'report-turn', timeout: 15, async: false },
    },
  ],
  recentRuns: [],
}

describe('HookEditorDialog', () => {
  test('creates a turn diff hook with all statuses and explains its Git boundary', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(<HookEditorDialog onSave={onSave} onClose={onClose} />)

    expect(screen.getByTestId('hook-editor-event')).toHaveValue('PostToolUse')
    fireEvent.change(screen.getByTestId('hook-editor-id'), { target: { value: 'turn-reporter' } })
    fireEvent.change(screen.getByTestId('hook-editor-name'), { target: { value: 'Turn reporter' } })
    fireEvent.change(screen.getByTestId('hook-editor-command'), {
      target: { value: 'report-turn' },
    })
    fireEvent.change(screen.getByTestId('hook-editor-event'), {
      target: { value: 'TurnCompleted' },
    })

    expect(screen.getByLabelText('轮次状态匹配表达式')).toHaveValue('.*')
    expect(screen.getByText(/包含同一仓库中子智能体和命令产生的改动/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('hook-editor-save'))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0][0].hooks).toEqual({
      TurnCompleted: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: 'report-turn', timeout: 10, async: false }],
        },
      ],
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  test('preserves subscriptions and every other handler when changing the edited event', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<HookEditorDialog plugin={plugin} onSave={onSave} onClose={vi.fn()} />)

    fireEvent.change(screen.getByTestId('hook-editor-event'), {
      target: { value: 'TurnCompleted' },
    })
    fireEvent.change(screen.getByTestId('hook-editor-command'), { target: { value: 'new-turn' } })
    fireEvent.click(screen.getByTestId('hook-editor-save'))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const draft = onSave.mock.calls[0][0]
    expect(draft.manifest).toEqual(plugin.manifest)
    expect(draft.hooks.PostToolUse).toEqual([
      { matcher: '^apply_patch$', hooks: [plugin.handlers[1].config] },
    ])
    expect(draft.hooks.TurnCompleted).toEqual([
      {
        matcher: '.*',
        hooks: [{ ...plugin.handlers[0].config, command: 'new-turn' }],
      },
      { matcher: '^completed$', hooks: [plugin.handlers[2].config] },
    ])
  })

  test('opens an existing turn hook with its status filter and preserves platform commands', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const turnPlugin: ResolvedHookPlugin = {
      ...plugin,
      handlers: [
        {
          ...plugin.handlers[2],
          config: {
            ...plugin.handlers[2].config,
            commandWindows: 'report-turn.exe',
            commands: { 'macos-aarch64': './bin/report-turn' },
          },
        },
      ],
    }
    render(<HookEditorDialog plugin={turnPlugin} onSave={onSave} onClose={vi.fn()} />)

    expect(screen.getByTestId('hook-editor-event')).toHaveValue('TurnCompleted')
    expect(screen.getByLabelText('轮次状态匹配表达式')).toHaveValue('^completed$')
    fireEvent.click(screen.getByTestId('hook-editor-save'))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0][0].hooks).toEqual({
      TurnCompleted: [{ matcher: '^completed$', hooks: [turnPlugin.handlers[0].config] }],
    })
  })
})
