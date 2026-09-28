import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { copyTextToClipboard } from '@/lib/clipboard'
import { AssistantMarkdown } from './AssistantMarkdown'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))
vi.mock('@/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(undefined))

const table = '| 角色 | 知识库 |\n| --- | --- |\n| **使用者** | `read` → 可见 |\n| 访客 | |'

test('copies only the selected table, including formatted cells and empty cells', async () => {
  const secondTable = table.replace('使用者', '管理员')
  render(<AssistantMarkdown content={`前文\n\n${table}\n\n后文\n\n${secondTable}`} />)

  const tables = screen.getAllByTestId('markdown-table')
  fireEvent.click(within(tables[1]).getByRole('button', { name: 'table.copy' }))

  await waitFor(() =>
    expect(within(tables[1]).getByRole('button', { name: 'table.copied' })).toBeInTheDocument()
  )
  expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith(secondTable)
  expect(within(tables[0]).getByRole('button', { name: 'table.copy' })).toBeInTheDocument()
})

test.each(['default', 'document'] as const)(
  'preserves alignment, escaped pipes and link destinations in %s Markdown',
  async variant => {
    const source = [
      '| 项目 | 说明 |',
      '| :--- | ---: |',
      '| **中文** | `a\\|b` |',
      '| [网页](https://example.com/page) | [文件](/tmp/report.md) |',
      '| ~~删除~~ | |',
    ].join('\n')
    render(<AssistantMarkdown content={`前文\n\n${source}\n\n后文`} variant={variant} />)

    fireEvent.click(screen.getByTestId('markdown-table-copy-button'))

    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith(source))
  }
)

test('copies the current table after the message changes', async () => {
  const { rerender } = render(<AssistantMarkdown content={table} />)
  rerender(<AssistantMarkdown content={`${table}\n| 新角色 | 新权限 |`} />)

  fireEvent.click(screen.getByTestId('markdown-table-copy-button'))

  await waitFor(() =>
    expect(copyTextToClipboard).toHaveBeenCalledWith(`${table}\n| 新角色 | 新权限 |`)
  )
})

test('shows a clipboard failure and allows retry', async () => {
  vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error('Clipboard unavailable'))
  render(<AssistantMarkdown content={table} />)

  fireEvent.click(screen.getByTestId('markdown-table-copy-button'))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('table.failed'))

  fireEvent.click(screen.getByRole('button', { name: 'table.failed' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('table.copied'))
  expect(copyTextToClipboard).toHaveBeenCalledTimes(2)
})

test('expands the selected table with formatting and restores keyboard focus on Escape', async () => {
  const user = userEvent.setup()
  render(
    <AssistantMarkdown
      content={`${table}\n\n| Other | Table |\n| --- | --- |\n| Different | Content |`}
    />
  )
  const trigger = screen.getAllByTestId('markdown-table-expand-button')[0]
  await user.click(trigger)

  const dialog = screen.getByRole('dialog', { name: 'table.expand' })
  expect(within(dialog).getAllByRole('row')).toHaveLength(3)
  expect(within(dialog).getByText('使用者').tagName).toBe('STRONG')
  expect(within(dialog).getByText('read').tagName).toBe('CODE')
  expect(within(dialog).queryByText('Different')).not.toBeInTheDocument()
  expect(screen.getByTestId('markdown-table-close-button')).toHaveFocus()

  await user.tab()
  expect(screen.getByTestId('markdown-table-close-button')).toHaveFocus()
  await user.tab({ shift: true })
  expect(screen.getByTestId('markdown-table-close-button')).toHaveFocus()
  await user.keyboard('{Escape}')

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  expect(document.body.style.overflow).not.toBe('hidden')
})

test('keeps the expanded table current and closes only via the close action or backdrop', async () => {
  const user = userEvent.setup()
  const { rerender } = render(<AssistantMarkdown content={table} />)
  await user.click(screen.getByTestId('markdown-table-expand-button'))
  rerender(<AssistantMarkdown content={`${table}\n| 新角色 | 新权限 |`} />)
  await user.click(within(screen.getByRole('dialog')).getByText('新角色'))
  expect(screen.getByRole('dialog')).toBeInTheDocument()

  await user.click(screen.getByTestId('markdown-table-close-button'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('markdown-table-expand-button'))
  await user.click(screen.getByTestId('markdown-table-dialog-overlay'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
