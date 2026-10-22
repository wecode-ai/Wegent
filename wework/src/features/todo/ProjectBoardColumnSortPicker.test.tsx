// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import {
  createProjectBoardSortLabels,
  type ProjectBoardSort,
} from '@wegent/collaboration/project-board'
import { CollaborationTheme } from '@wegent/collaboration/theme'
import { ProjectBoardColumnSortPicker } from '../../../../packages/collaboration/src/project-board/ProjectBoardColumnSortPicker'
import { boardSortMessages } from '../../../../packages/collaboration/src/project-board/messages'

const id = 'cloud-board-sort-by-pending'
const labels = createProjectBoardSortLabels(key => boardSortMessages['zh-CN'][key])
function Editor() {
  const [value, setValue] = useState<ProjectBoardSort>(['priority-desc'])
  return (
    <CollaborationTheme mode="dark">
      <ProjectBoardColumnSortPicker
        columnKey="pending"
        columnLabel="待开始"
        labels={labels}
        value={value}
        onChange={setValue}
      />
      <button data-testid="outside">Outside</button>
    </CollaborationTheme>
  )
}

describe('lane sort editor', () => {
  it('edits compound rules, prevents duplicate fields, and changes rule precedence', async () => {
    const user = userEvent.setup()
    render(<Editor />)
    const trigger = screen.getByTestId(id)
    await user.click(trigger)
    const popover = screen.getByTestId(`${id}-popover`)
    expect(popover).toHaveAttribute('data-theme', 'dark')
    expect(popover).toHaveAccessibleName('待开始 · 排序方式')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await user.click(screen.getByTestId(`${id}-add`))
    expect(trigger).toHaveAttribute('data-sort-rules', 'priority-desc,created-desc')
    await user.click(screen.getByTestId(`${id}-rule-1-mode`))
    expect(screen.queryByTestId(`${id}-rule-1-mode-priority-desc`)).not.toBeInTheDocument()
    await user.click(screen.getByTestId(`${id}-rule-1-mode-created-asc`))
    expect(popover).toBeInTheDocument()
    expect(trigger).toHaveAttribute('data-sort-rules', 'priority-desc,created-asc')
    await user.click(screen.getByTestId(`${id}-rule-1-up`))
    expect(trigger).toHaveAttribute('data-sort-rules', 'created-asc,priority-desc')
    await user.click(screen.getByTestId(`${id}-rule-0-down`))
    expect(trigger).toHaveAttribute('data-sort-rules', 'priority-desc,created-asc')
    await user.click(screen.getByTestId(`${id}-add`))
    expect(trigger).toHaveAttribute('data-sort-rules', 'priority-desc,created-asc,updated-desc')
    expect(screen.getByTestId(`${id}-add`)).toBeDisabled()
    expect(screen.getByTestId(`${id}-rule-0-up`)).toBeDisabled()
    expect(screen.getByTestId(`${id}-rule-2-down`)).toBeDisabled()
    await user.click(screen.getByTestId(`${id}-rule-1-remove`))
    expect(trigger).toHaveAttribute('data-sort-rules', 'priority-desc,updated-desc')
    await user.click(screen.getByTestId(`${id}-manual`))
    expect(trigger).toHaveAttribute('data-sort-rules', 'manual')
    expect(screen.getByTestId(`${id}-manual`)).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByTestId(`${id}-add`))
    expect(trigger).toHaveAttribute('data-sort-rules', 'priority-desc')
    await user.click(screen.getByTestId(`${id}-rule-0-remove`))
    expect(trigger).toHaveAttribute('data-sort-rules', 'manual')
  })

  it('supports keyboard dismissal of nested choices and restores focus to each trigger', async () => {
    const user = userEvent.setup()
    render(<Editor />)
    const trigger = screen.getByTestId(id)
    trigger.focus()
    await user.keyboard('{Enter}')
    const ruleTrigger = screen.getByTestId(`${id}-rule-0-mode`)
    expect(ruleTrigger).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId(`${id}-rule-0-mode-priority-desc`)).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId(`${id}-rule-0-mode-options`)).not.toBeInTheDocument()
    expect(screen.getByTestId(`${id}-popover`)).toBeInTheDocument()
    await waitFor(() => expect(ruleTrigger).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId(`${id}-popover`)).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
    await user.click(trigger)
    await user.click(screen.getByTestId('outside'))
    expect(screen.queryByTestId(`${id}-popover`)).not.toBeInTheDocument()
  })
})
