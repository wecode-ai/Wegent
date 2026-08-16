import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { IssueComposer } from './IssueComposer'
import { issueDraftFromText } from './issueComposerDraft'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

describe('IssueComposer', () => {
  it('uses the first line as the title and remaining lines as the description', () => {
    expect(issueDraftFromText('完成发布验证\n覆盖创建和完成链路\n补充截图')).toEqual({
      title: '完成发布验证',
      description: '覆盖创建和完成链路\n补充截图',
    })
  })

  it('creates an issue in the selected board from one lightweight input', async () => {
    const onCreate = vi.fn()
    render(
      <IssueComposer
        boards={[
          { key: 'backend:1', name: '产品发布' },
          { key: 'local:2', name: '体验优化' },
        ]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    await userEvent.selectOptions(screen.getByTestId('workspace-issue-board'), 'local:2')
    await userEvent.type(
      screen.getByTestId('workspace-issue-input'),
      '修复工作空间创建入口\n只创建 Issue'
    )
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'local:2',
      title: '修复工作空间创建入口',
      description: '只创建 Issue',
    })
  })

  it('supports the command-enter shortcut', async () => {
    const onCreate = vi.fn()
    render(
      <IssueComposer
        boards={[{ key: 'backend:1', name: '产品发布' }]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    const input = screen.getByTestId('workspace-issue-input')
    fireEvent.change(input, { target: { value: '快捷创建 Issue' } })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '快捷创建 Issue',
      description: '',
    })
  })

  it('closes with Escape without showing a duplicate cancel action', () => {
    const onCancel = vi.fn()
    render(
      <IssueComposer
        boards={[{ key: 'backend:1', name: '产品发布' }]}
        initialBoardKey="backend:1"
        onCancel={onCancel}
        onCreate={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('workspace-issue-input'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
