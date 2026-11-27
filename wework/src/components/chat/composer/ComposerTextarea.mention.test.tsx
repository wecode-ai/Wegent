import type { WorkspaceTarget } from '@/types/workspace-files'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getComposerDiagnosticsSnapshot } from '@wegent/collaboration/composer/composerDiagnostics'
import { createRef, useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { clearComposerAppsSnapshot, resetComposerAppsMemory } from './composerAppsSnapshot'
import { ComposerTextarea } from './ComposerTextarea'

beforeEach(() => {
  resetComposerAppsMemory()
  clearComposerAppsSnapshot()
  delete window.__WEWORK_DSH_EXTENSIONS__
})

test('consumes the Tab that confirms the highlighted @ mention', async () => {
  const textareaRef = createRef<HTMLElement>()
  const searchWorkspaceEntries = vi.fn().mockResolvedValue({
    files: [
      {
        root: '/workspace/project',
        path: 'src/auth.ts',
        fileName: 'auth.ts',
        matchType: 'file',
        score: 100,
        indices: [4, 5, 6, 7],
      },
    ],
  })
  const workspaceTarget: WorkspaceTarget = {
    deviceId: 'local-device',
    path: '/workspace/project',
    source: 'project',
  }

  function Harness() {
    const [value, setValue] = useState('')
    return (
      <ComposerTextarea
        value={value}
        onChange={setValue}
        onSubmit={vi.fn()}
        canSend={false}
        placeholder="Message"
        rows={2}
        textareaRef={textareaRef}
        className="min-h-12"
        workspaceTarget={workspaceTarget}
        workspaceFileApi={{
          listWorkspaceEntries: vi.fn(),
          searchWorkspaceEntries,
          readWorkspaceTextFile: vi.fn(),
        }}
      />
    )
  }

  render(<Harness />)
  const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
  await act(async () => {
    editor.focus()
    editor.value = '@auth'
  })

  await waitFor(() => {
    expect(screen.getByTestId('workspace-mention-option-0')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(editor).toHaveFocus()
  })
  let tabPropagated = true
  await act(async () => {
    tabPropagated = fireEvent.keyDown(editor, {
      key: 'Tab',
      code: 'Tab',
      keyCode: 9,
      charCode: 9,
    })
  })
  expect(tabPropagated, JSON.stringify(getComposerDiagnosticsSnapshot())).toBe(false)
  await waitFor(() => {
    expect(editor.value, JSON.stringify(getComposerDiagnosticsSnapshot())).toContain(
      '[$auth.ts](file://'
    )
    expect(screen.getByTestId('composer-path-chip-auth-ts')).toHaveAttribute(
      'data-composer-path',
      '/workspace/project/src/auth.ts'
    )
    expect(screen.getByTestId('composer-path-chip-auth-ts')).toHaveTextContent('auth.ts')
  })
})
