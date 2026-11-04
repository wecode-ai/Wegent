import '@/i18n'
import { preloadDefaultDshUiTestModules } from '@/test/setup.dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DesktopEmptyTaskLauncher } from './DesktopEmptyTaskLauncher'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))

beforeEach(async () => {
  await preloadDefaultDshUiTestModules(['plugins/wework-ui-home-developer.js'])
})

function LauncherHarness({
  projectName = 'Wegent',
  showWorkbenchBackground = false,
  onOpenProjectSelector = vi.fn(),
  searchActive = false,
}: {
  projectName?: string | null
  showWorkbenchBackground?: boolean
  onOpenProjectSelector?: (anchorElement: HTMLButtonElement) => void
  searchActive?: boolean
}) {
  const [draft, setDraft] = useState('已有草稿')
  return (
    <DesktopEmptyTaskLauncher
      searchActive={searchActive}
      projectName={projectName}
      showWorkbenchBackground={showWorkbenchBackground}
      onOpenProjectSelector={onOpenProjectSelector}
      onSelectSuggestion={setDraft}
      composer={
        <input
          data-testid="chat-message-input"
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
      }
    />
  )
}

describe('DesktopEmptyTaskLauncher', () => {
  test('replaces the draft from a secondary suggestion without submitting and keeps focus local', async () => {
    render(<LauncherHarness />)

    await userEvent.click(screen.getByTestId('task-suggestion-category-build'))

    const suggestions = within(screen.getByTestId('task-suggestion-list'))
      .getAllByRole('button')
      .map(button => button.textContent)
    expect(suggestions).toEqual([
      '返回全部建议',
      '构建功能',
      '构建 UI 更改',
      '构建原型',
      '构建内部工具',
    ])

    await userEvent.click(screen.getByTestId('task-suggestion-build-ui'))

    const input = screen.getByTestId('chat-message-input')
    expect(input).toHaveValue('构建 UI 更改 ')
    await waitFor(() => expect(input).toHaveFocus())
    expect(screen.getByTestId('task-suggestion-list')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('task-suggestions-back-button'))
    expect(screen.getByTestId('task-suggestion-categories')).toBeInTheDocument()
  })
})
