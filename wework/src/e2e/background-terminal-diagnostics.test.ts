import { expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { collectBackgroundTerminalDiagnostics } from './background-terminal-diagnostics'

function commandMessage(id: string, command: string, output: string): WorkbenchMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    status: 'done',
    createdAt: '2026-10-23T00:00:00Z',
    blocks: [
      {
        id,
        subtaskId: 'turn-1',
        type: 'tool',
        toolName: 'bash',
        status: 'streaming',
        createdAt: 1,
        toolInput: { command },
        toolOutput: output,
        renderPayload: { kind: 'command_execution', status: 'inProgress', processId: '42' },
      },
    ],
  }
}

function terminalViewport() {
  const root = document.createElement('div')
  root.innerHTML = `<section data-testid="background-terminal-output-panel">
    <div class="xterm-accessibility-tree">
      <div role="listitem" aria-posinset="15" aria-setsize="60">fixture_tick_14</div>
      <div role="listitem" aria-posinset="16" aria-setsize="60">fixture_tick_15</div>
    </div>
    <div role="log">Earlier announcements are not viewport rows</div>
  </section>`
  return root
}

test('captures only the requested fixture output and current accessibility viewport', () => {
  const output = 'fixture\nfixture_tick_1\nfixture_tick_3\n'
  const diagnostics = collectBackgroundTerminalDiagnostics(
    [
      commandMessage('fixture', 'node fixture', output),
      commandMessage('other', 'node unrelated', 'unrelated private output'),
    ],
    'task-1',
    'fixture',
    terminalViewport()
  )
  expect(diagnostics.terminals).toEqual([
    {
      id: 'fixture',
      output,
      status: 'streaming',
      process: { kind: 'command_execution', status: 'inProgress', processId: '42' },
    },
  ])
  expect(diagnostics.rows).toEqual([
    { position: '15', size: '60', text: 'fixture_tick_14' },
    { position: '16', size: '60', text: 'fixture_tick_15' },
  ])
  expect(JSON.stringify(diagnostics)).not.toContain('unrelated private output')
})

test.each(['missing', ''])('omits output and viewport for an unmatched marker (%s)', marker => {
  expect(
    collectBackgroundTerminalDiagnostics(
      [commandMessage('fixture', 'node fixture', 'private output')],
      'task-1',
      marker,
      terminalViewport()
    )
  ).toEqual({ marker, terminals: [], rows: [] })
})
