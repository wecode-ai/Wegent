// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import client, { ApiError } from '@/apis/client'
import { DeleteDocumentDialog } from '@/features/knowledge/document/components/DeleteDocumentDialog'
import type { KnowledgeDocument } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const document = { id: 11, name: 'document.txt' } as KnowledgeDocument

afterEach(() => jest.restoreAllMocks())

it.each([false, true])(
  'does not dispatch deletion after the account changes before render (continuing=%s)',
  async continuing => {
    const cacheScope = jest.spyOn(client, 'getCacheScope').mockReturnValue('original-account')
    const confirm = jest.fn().mockRejectedValue(
      new ApiError('External failure', 502, 'external_engine_unavailable', {
        code: 'external_engine_unavailable',
        can_continue: true,
      })
    )
    render(
      <DeleteDocumentDialog open document={document} onOpenChange={jest.fn()} onConfirm={confirm} />
    )
    if (continuing) {
      fireEvent.click(screen.getByTestId('confirm-delete-document'))
      await screen.findByTestId('continue-delete-document')
    }

    cacheScope.mockReturnValue('different-account-or-backend')
    fireEvent.click(
      screen.getByTestId(continuing ? 'continue-delete-document' : 'confirm-delete-document')
    )

    expect(confirm).toHaveBeenCalledTimes(continuing ? 1 : 0)
    expect(screen.queryByTestId('continue-delete-document')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  }
)

it('clears continuation eligibility if a retry encounters an internal error', async () => {
  const confirm = jest
    .fn()
    .mockRejectedValueOnce(
      new ApiError('External cleanup failed', 502, 'external_engine_unavailable', {
        code: 'external_engine_unavailable',
        can_continue: true,
      })
    )
    .mockRejectedValueOnce(new ApiError('Runtime unavailable', 502, 'remote_transport_error'))
  render(
    <DeleteDocumentDialog open document={document} onOpenChange={jest.fn()} onConfirm={confirm} />
  )
  fireEvent.click(screen.getByTestId('confirm-delete-document'))
  fireEvent.click(await screen.findByTestId('continue-delete-document'))
  await waitFor(() =>
    expect(screen.queryByTestId('continue-delete-document')).not.toBeInTheDocument()
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('Runtime unavailable')
  expect(confirm).toHaveBeenLastCalledWith(true)
})

it('drops a previous target confirmation when the selected document changes', async () => {
  const confirm = jest.fn().mockRejectedValue(
    new ApiError('External failure', 502, 'external_engine_unavailable', {
      code: 'external_engine_unavailable',
      can_continue: true,
    })
  )
  const { rerender } = render(
    <DeleteDocumentDialog open document={document} onOpenChange={jest.fn()} onConfirm={confirm} />
  )
  fireEvent.click(screen.getByTestId('confirm-delete-document'))
  await screen.findByTestId('continue-delete-document')
  rerender(
    <DeleteDocumentDialog
      open
      document={{ ...document, id: 12 }}
      onOpenChange={jest.fn()}
      onConfirm={confirm}
    />
  )
  expect(screen.queryByTestId('continue-delete-document')).not.toBeInTheDocument()
})
