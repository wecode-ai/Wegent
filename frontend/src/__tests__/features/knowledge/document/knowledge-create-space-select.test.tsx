// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeCreateSpaceSelect } from '@/features/knowledge/document/components/KnowledgeCreateSpaceSelect'
import type { AvailableGroup } from '@/features/knowledge/document/components/CreateKnowledgeBaseDialog'

jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const spaces: AvailableGroup[] = [
  { id: 'personal', name: 'default', displayName: 'Personal', type: 'personal', canCreate: true },
  {
    id: 'group-alpha',
    name: 'alpha-space',
    displayName: 'Same team',
    type: 'group',
    canCreate: true,
  },
  {
    id: 'group-beta',
    name: 'beta-space',
    displayName: 'Same team',
    type: 'group',
    canCreate: true,
  },
  {
    id: 'organization',
    name: 'company',
    displayName: 'Company',
    type: 'organization',
    canCreate: false,
  },
]

it('searches local names and identifiers, selects by identity and resets search on reopening', async () => {
  const changed = jest.fn()
  function Picker() {
    const [value, setValue] = useState('personal')
    return (
      <KnowledgeCreateSpaceSelect
        spaces={spaces}
        value={value}
        onValueChange={next => {
          changed(next)
          setValue(next)
        }}
      />
    )
  }
  render(<Picker />)
  const user = userEvent.setup()
  expect(screen.getByTestId('group-selector')).toHaveTextContent('Personal')
  await user.click(screen.getByTestId('group-selector'))
  expect(screen.getAllByTestId(/^create-space-option-/)).toHaveLength(3)
  await user.type(screen.getByTestId('create-space-search'), ' SAME ')
  expect(screen.getAllByTestId(/^create-space-option-/)).toHaveLength(2)
  await user.clear(screen.getByTestId('create-space-search'))
  await user.type(screen.getByTestId('create-space-search'), 'BETA-SPACE')
  expect(screen.queryByTestId('create-space-option-group-alpha')).not.toBeInTheDocument()
  await user.keyboard('{ArrowDown}{Enter}')
  expect(changed).toHaveBeenLastCalledWith('group-beta')
  expect(screen.getByTestId('group-selector')).toHaveTextContent('Same team')
  await user.click(screen.getByTestId('group-selector'))
  expect(screen.getByTestId('create-space-search')).toHaveValue('')
  expect(screen.getByTestId('create-space-option-personal')).toBeVisible()
})

it('never reveals unauthorized company spaces through search and follows updated create permissions', async () => {
  const props = { value: 'personal', onValueChange: jest.fn() }
  const { rerender } = render(<KnowledgeCreateSpaceSelect {...props} spaces={spaces} />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('group-selector'))
  await user.type(screen.getByTestId('create-space-search'), 'company')
  expect(screen.queryByTestId('create-space-option-organization')).not.toBeInTheDocument()
  expect(screen.getByText('document.creation.noMatchingSpaces')).toBeVisible()
  rerender(
    <KnowledgeCreateSpaceSelect
      {...props}
      spaces={spaces.map(space => ({ ...space, canCreate: true }))}
    />
  )
  expect(screen.getByTestId('create-space-option-organization')).toBeVisible()
  await user.click(screen.getByTestId('create-space-option-organization'))
  expect(props.onValueChange).toHaveBeenCalledWith('organization')
  await user.click(screen.getByTestId('group-selector'))
  rerender(<KnowledgeCreateSpaceSelect {...props} spaces={spaces} />)
  expect(screen.queryByTestId('create-space-option-organization')).not.toBeInTheDocument()
})

it('allows wheel events to scroll the space list inside a modal creation dialog', async () => {
  const { Dialog, DialogContent, DialogTitle } = await import('@/components/ui/dialog')
  render(
    <Dialog open>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Create library</DialogTitle>
        <KnowledgeCreateSpaceSelect spaces={spaces} value="personal" onValueChange={jest.fn()} />
      </DialogContent>
    </Dialog>
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('group-selector'))
  const list = screen.getByRole('listbox')
  // JSDOM has no layout; supply the overflow dimensions for the real scroll-lock handler.
  Object.defineProperties(list, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } })
  expect(fireEvent.wheel(list, { deltaY: 100, cancelable: true, bubbles: true })).toBe(true)
  fireEvent.touchStart(list, {
    touches: [{ clientX: 100, clientY: 200 }],
    changedTouches: [{ clientX: 100, clientY: 200 }],
  })
  expect(
    fireEvent.touchMove(list, {
      touches: [{ clientX: 100, clientY: 100 }],
      changedTouches: [{ clientX: 100, clientY: 100 }],
      cancelable: true,
      bubbles: true,
    })
  ).toBe(true)
  expect(fireEvent.wheel(document.body, { deltaY: 100, cancelable: true, bubbles: true })).toBe(
    false
  )
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Create library' })).toBeVisible()
  await waitFor(() => expect(screen.getByTestId('group-selector')).toHaveFocus())
})
