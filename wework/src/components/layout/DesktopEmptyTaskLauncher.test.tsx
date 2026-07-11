import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DesktopEmptyTaskLauncher } from './DesktopEmptyTaskLauncher'

function LauncherHarness({
  projectName = 'Wegent',
  onOpenProjectSelector = vi.fn(),
}: {
  projectName?: string | null
  onOpenProjectSelector?: (anchorElement: HTMLButtonElement) => void
}) {
  const [draft, setDraft] = useState('已有草稿')
  return (
    <DesktopEmptyTaskLauncher
      projectName={projectName}
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
  test('renders the project-aware heading and ordered suggestion categories', () => {
    render(<LauncherHarness />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '我们应该在 Wegent 中做些什么？'
    )
    const categoryLabels = within(screen.getByTestId('task-suggestion-categories'))
      .getAllByRole('button')
      .map(button => button.textContent)
    expect(categoryLabels).toEqual([
      '探索并理解代码',
      '构建新功能、应用或工具',
      '审查代码并提出修改建议',
      '修复问题和失败',
    ])
  })

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

  test('uses the generic heading when no project is selected', () => {
    render(<LauncherHarness projectName={null} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('我们该做什么？')
    expect(screen.queryByTestId('empty-project-title-button')).not.toBeInTheDocument()
  })

  test('passes the title button as the project chooser anchor', async () => {
    const onOpenProjectSelector = vi.fn()
    render(<LauncherHarness onOpenProjectSelector={onOpenProjectSelector} />)

    const titleButton = screen.getByTestId('empty-project-title-button')
    await userEvent.click(titleButton)

    expect(onOpenProjectSelector).toHaveBeenCalledWith(titleButton)
  })
})
