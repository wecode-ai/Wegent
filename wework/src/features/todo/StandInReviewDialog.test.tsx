import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import { StandInReviewDialog } from './StandInReviewDialog'

it('opens only on request, focuses close and returns focus without confirming on Escape', async () => {
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  function Review() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>查看待确认配置</button>
        <StandInReviewDialog
          open={open}
          title="待确认配置"
          testId="review"
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        >
          <button onClick={onConfirm}>确认并应用</button>
        </StandInReviewDialog>
      </>
    )
  }
  render(<Review />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  const user = userEvent.setup()
  const entry = screen.getByRole('button', { name: '查看待确认配置' })
  await user.click(entry)
  expect(screen.getByRole('dialog', { name: '待确认配置' })).toHaveAttribute('aria-modal', 'true')
  const close = screen.getByTestId('review-close')
  expect(close).toHaveFocus()
  await user.tab({ shift: true })
  expect(screen.getByRole('button', { name: '确认并应用' })).toHaveFocus()
  await user.tab()
  expect(close).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(onConfirm).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(entry).toHaveFocus()
})

it('does not dismiss a review while its existing operation is pending', async () => {
  const onClose = vi.fn()
  render(
    <StandInReviewDialog open busy title="待确认配置" testId="review" onClose={onClose}>
      <p>正在保存</p>
    </StandInReviewDialog>
  )
  expect(screen.getByTestId('review-close')).toBeDisabled()
  await userEvent.keyboard('{Escape}')
  const dialog = screen.getByRole('dialog')
  fireEvent.click(dialog.parentElement!)
  expect(onClose).not.toHaveBeenCalled()
})

it('closes from the backdrop without treating content clicks as dismissal', () => {
  const onClose = vi.fn()
  render(
    <StandInReviewDialog open title="状态详情" testId="review" onClose={onClose}>
      <p>连接需要检查</p>
    </StandInReviewDialog>
  )
  fireEvent.click(screen.getByText('连接需要检查'))
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('dialog').parentElement!)
  expect(onClose).toHaveBeenCalledTimes(1)
})
