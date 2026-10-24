import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInMemory } from '@/api/standIn'
import { newStandInRole } from '@/api/personalStandIn'
import '@/i18n'
import { StandInMemoryPanel } from './StandInMemoryPanel'

function fixture() {
  const row: StandInMemory = {
    id: 'memory-1',
    content: '回复简洁',
    scope: { kind: 'personal' },
    version: 2,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
  }
  const api = {
    memories: vi.fn(async () => [row]),
    saveMemory: vi.fn(async (_user, _device, memory) => ({ ...row, ...memory, version: 3 })),
    deleteMemory: vi.fn(async () => {}),
  }
  const onClose = vi.fn()
  const settings = {
    userId: 7,
    executionDeviceId: 'mac',
    version: 1,
    autoSelect: false,
    roles: [{ ...newStandInRole('mac', 'review'), name: '评审角色' }],
  }
  return {
    api,
    row,
    onClose,
    settings,
    render: () =>
      render(
        <StandInMemoryPanel
          api={api as unknown as StandInExecutorApi}
          settings={settings}
          onClose={onClose}
        />
      ),
  }
}

it('edits the exact version, changes scope, and confirms forgetting through the selected executor', async () => {
  const f = fixture()
  f.render()
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-edit'))
  await user.clear(screen.getByTestId('stand-in-memory-content'))
  await user.type(screen.getByTestId('stand-in-memory-content'), '评审时先列风险')
  await user.selectOptions(
    screen.getByTestId('stand-in-memory-scope'),
    JSON.stringify({ kind: 'role', roleId: 'review' })
  )
  await user.click(screen.getByTestId('stand-in-memory-save'))
  await waitFor(() =>
    expect(f.api.saveMemory).toHaveBeenCalledWith(7, 'mac', {
      ...f.row,
      content: '评审时先列风险',
      scope: { kind: 'role', roleId: 'review' },
    })
  )
  await user.click(await screen.findByTestId('stand-in-memory-delete'))
  expect(f.api.deleteMemory).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-memory-delete-confirm'))
  await waitFor(() => expect(f.api.deleteMemory).toHaveBeenCalledWith(7, 'mac', 'memory-1', 3))
  expect(
    await screen.findByText('还没有记忆。你可以在聊天中说“记住……”，也可以在这里添加。')
  ).toBeInTheDocument()
})

it('preserves unsaved edits on failure and requires discarding before closing', async () => {
  const f = fixture()
  f.api.saveMemory.mockRejectedValue(new Error('task changed'))
  f.render()
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-edit'))
  await user.type(screen.getByTestId('stand-in-memory-content'), '，先问我')
  await user.click(screen.getByTestId('stand-in-memory-save'))
  expect(await screen.findByRole('alert')).toHaveTextContent('task changed')
  expect(screen.getByTestId('stand-in-memory-content')).toHaveValue('回复简洁，先问我')
  await user.click(screen.getByTestId('stand-in-memory-close'))
  expect(f.onClose).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-memory-keep'))
  expect(screen.getByTestId('stand-in-memory-content')).toHaveValue('回复简洁，先问我')
})
