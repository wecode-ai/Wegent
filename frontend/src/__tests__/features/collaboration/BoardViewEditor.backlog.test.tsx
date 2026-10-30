// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BoardViewEditor, type SavedBoardView } from '@wegent/collaboration/project-board'
import { createCollaborationTranslator } from '@wegent/collaboration'

const initial: SavedBoardView = {
  id: 'stages',
  name: 'Stages',
  columns: [{ id: 'design', type: 'tag', value: 'design' }],
}

beforeAll(() => {
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: jest.fn(() => 'new-lane'),
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.removeAttribute('open')
    },
  })
})
afterEach(cleanup)
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

it('saves a named Backlog, prevents a second one, and restores its editor', async () => {
  const save = jest.fn().mockResolvedValue(undefined)
  const props = {
    initial,
    statuses: [],
    tags: ['design'],
    translate: createCollaborationTranslator('zh-CN'),
    onSave: save,
    onClose: jest.fn(),
  }
  const rendered = render(<BoardViewEditor {...props} />)
  fireEvent.click(screen.getByTestId('board-view-add-lane'))
  fireEvent.change(screen.getByTestId('board-view-lane-type-1'), { target: { value: 'unmatched' } })
  expect(screen.getByTestId('board-view-lane-value-1')).toHaveValue('Backlog')
  fireEvent.change(screen.getByTestId('board-view-lane-value-1'), { target: { value: '待规划' } })
  expect(
    screen.getByTestId('board-view-lane-type-0').querySelector('option[value="unmatched"]')
  ).toBeDisabled()
  fireEvent.click(screen.getByTestId('board-view-save'))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  const saved = save.mock.calls[0][0]
  expect(saved.columns[1]).toMatchObject({ type: 'unmatched', value: '待规划' })
  rendered.unmount()
  render(<BoardViewEditor {...props} initial={saved} />)
  expect(screen.getByTestId('board-view-lane-value-1')).toHaveValue('待规划')
})

it('rejects duplicate Backlog lanes even with different names', async () => {
  const save = jest.fn()
  render(
    <BoardViewEditor
      initial={{
        ...initial,
        columns: [
          { id: 'one', type: 'unmatched', value: 'Backlog' },
          { id: 'two', type: 'unmatched', value: 'Other' },
        ],
      }}
      statuses={[]}
      tags={[]}
      translate={createCollaborationTranslator('zh-CN')}
      onSave={save}
      onClose={jest.fn()}
    />
  )
  fireEvent.click(screen.getByTestId('board-view-save'))
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(save).not.toHaveBeenCalled()
})
