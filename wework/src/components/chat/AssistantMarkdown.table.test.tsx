import { copyTextToClipboard } from '@/lib/clipboard'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))
vi.mock('@/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(undefined))

const table = '| 角色 | 知识库 |\n| --- | --- |\n| **使用者** | `read` → 可见 |\n| 访客 | |'

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
