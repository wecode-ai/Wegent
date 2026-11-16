// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useBatchDeletion } from '@/features/knowledge/document/hooks/useBatchDeletion'
import { BatchDeletionDialog } from '@/features/knowledge/document/components/BatchDeletionDialog'
import type { BatchDeletionResult } from '@/apis/knowledge'
import type { BatchDocumentDeletionOutcome } from '@/apis/knowledge-deletion'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      values && 'deleted' in values
        ? `${key}: ${values.deleted}/${values.unconfirmed}/${values.failed}`
        : key,
  }),
}))

type Run = (ids: number[], continuing: boolean) => Promise<BatchDeletionResult | null>
const success = (id: number, unconfirmed = false): BatchDocumentDeletionOutcome => ({
  document_id: id,
  content_deleted: true,
  index_cleanup: unconfirmed ? 'unconfirmed' : 'confirmed',
  error_code: unconfirmed ? 'external_engine_unavailable' : null,
  can_continue: false,
})
const failure = (id: number, eligible: boolean): BatchDocumentDeletionOutcome => ({
  document_id: id,
  content_deleted: false,
  index_cleanup: 'unconfirmed',
  error_code: eligible ? 'external_engine_unavailable' : 'permission_denied',
  can_continue: eligible,
})
const first: BatchDeletionResult = {
  success_count: 6,
  failed_count: 4,
  failed_ids: [7, 8, 9, 10],
  unconfirmed_count: 0,
  message: 'Partial deletion',
  items: [
    ...[1, 2, 3, 4, 5, 6].map(id => success(id)),
    failure(7, true),
    failure(8, true),
    failure(9, true),
    failure(10, false),
  ],
}
const continued: BatchDeletionResult = {
  success_count: 3,
  failed_count: 0,
  failed_ids: [],
  unconfirmed_count: 3,
  message: 'Deleted',
  items: [success(7, true), success(8, true), success(9, true)],
}

function Harness({
  run,
  scope = 'library',
  onResult = jest.fn(),
}: {
  run: Run
  scope?: string
  onResult?: () => void
}) {
  const deletion = useBatchDeletion({ scope, run, onResult })
  return (
    <>
      <button
        data-testid="start-batch"
        onClick={() => deletion.start([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1])}
      >
        Delete
      </button>
      <BatchDeletionDialog
        {...deletion}
        onContinue={deletion.continueDeletion}
        onClose={deletion.close}
      />
    </>
  )
}

it('confirms only eligible failures once and keeps cumulative results', async () => {
  const run = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(continued)
  render(<Harness run={run} />)
  fireEvent.click(screen.getByTestId('start-batch'))
  expect(await screen.findByTestId('batch-deletion-summary')).toHaveTextContent('6/0/4')
  fireEvent.click(screen.getByTestId('continue-batch-deletion'))
  await waitFor(() =>
    expect(screen.getByTestId('batch-deletion-summary')).toHaveTextContent('9/3/1')
  )
  expect(run.mock.calls).toEqual([
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], false],
    [[7, 8, 9], true],
  ])
  expect(screen.queryByTestId('continue-batch-deletion')).not.toBeInTheDocument()
  expect(screen.getByText('document.deletion.residualWarning')).toBeInTheDocument()
  expect(screen.getByTestId('batch-deletion-item-10')).toHaveTextContent('batchRejected')
})

it('cancel leaves the initial partial deletion intact without another request', async () => {
  const run = jest.fn().mockResolvedValue(first)
  const onResult = jest.fn()
  render(<Harness run={run} onResult={onResult} />)
  fireEvent.click(screen.getByTestId('start-batch'))
  await screen.findByTestId('continue-batch-deletion')
  fireEvent.click(screen.getByTestId('cancel-batch-deletion'))
  expect(screen.queryByTestId('batch-deletion-dialog')).not.toBeInTheDocument()
  expect(run).toHaveBeenCalledTimes(1)
  expect(onResult).toHaveBeenCalledTimes(1)
})

it('drops old continuation eligibility after an unknown request failure', async () => {
  const run = jest
    .fn()
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new Error('Runtime disconnected'))
  render(<Harness run={run} />)
  fireEvent.click(screen.getByTestId('start-batch'))
  fireEvent.click(await screen.findByTestId('continue-batch-deletion'))
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('document.deletion.batchRequestFailed')
  )
  expect(screen.queryByTestId('continue-batch-deletion')).not.toBeInTheDocument()
})

it('ignores a response after navigating to a different resource', async () => {
  let finish!: (result: BatchDeletionResult) => void
  const run = jest.fn(
    () =>
      new Promise<BatchDeletionResult>(resolve => {
        finish = resolve
      })
  )
  const onResult = jest.fn()
  const { rerender } = render(<Harness run={run} onResult={onResult} />)
  fireEvent.click(screen.getByTestId('start-batch'))
  rerender(<Harness run={run} onResult={onResult} scope="other-library" />)
  await act(async () => {
    finish(first)
  })
  expect(screen.queryByTestId('batch-deletion-dialog')).not.toBeInTheDocument()
  expect(onResult).not.toHaveBeenCalled()
})

it('does not submit the continuation twice while it is pending', async () => {
  let finish!: (result: BatchDeletionResult) => void
  const run = jest
    .fn()
    .mockResolvedValueOnce(first)
    .mockImplementationOnce(
      () =>
        new Promise<BatchDeletionResult>(resolve => {
          finish = resolve
        })
    )
  render(<Harness run={run} />)
  fireEvent.click(screen.getByTestId('start-batch'))
  const button = await screen.findByTestId('continue-batch-deletion')
  fireEvent.click(button)
  fireEvent.click(button)
  expect(run).toHaveBeenCalledTimes(2)
  expect(button).toBeDisabled()
  await act(async () => {
    finish(continued)
  })
})

it('keeps renewed permission and internal failures without retrying them', async () => {
  const run = jest
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({
      success_count: 1,
      failed_count: 2,
      failed_ids: [7, 9],
      unconfirmed_count: 1,
      message: 'Partial',
      items: [
        { ...failure(7, false), error_code: 'internal_error' },
        success(8, true),
        failure(9, false),
      ],
    })
  render(<Harness run={run} />)
  fireEvent.click(screen.getByTestId('start-batch'))
  fireEvent.click(await screen.findByTestId('continue-batch-deletion'))
  await waitFor(() =>
    expect(screen.getByTestId('batch-deletion-summary')).toHaveTextContent('7/1/3')
  )
  expect(screen.queryByTestId('continue-batch-deletion')).not.toBeInTheDocument()
  expect(screen.getByTestId('batch-deletion-item-7')).toHaveTextContent('batchFailed')
  expect(run).toHaveBeenCalledTimes(2)
})
