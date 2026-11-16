import '@/i18n'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInMemoryRule } from '@/api/standIn'
import { StandInMemoryRules } from './StandInMemoryRules'

const rule = (id: string): Extract<StandInMemoryRule, { kind: 'forgetting_rule' }> => ({
  id,
  kind: 'forgetting_rule',
  content: id,
  scope: { kind: 'personal' },
  version: 1,
  createdAt: '2026-11-08T00:00:00Z',
  updatedAt: '2026-11-08T00:00:00Z',
})

it('shows legacy fingerprints only in owner management and sends their revision on confirmed deletion', async () => {
  const legacy: StandInMemoryRule = {
    kind: 'legacy_fingerprint',
    id: 'stand-in-forgotten:abcdef123456',
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000000Z',
  }
  const deleteMemoryRule = vi.fn().mockResolvedValue(undefined)
  const props = {
    api: {
      memoryRules: vi.fn().mockResolvedValue([legacy]),
      deleteMemoryRule,
    } as unknown as StandInExecutorApi,
    userId: 7,
    deviceId: 'mac',
    label: vi.fn(),
    refreshKey: 0,
    disabled: false,
    onBusyChange: vi.fn(),
  }
  const view = render(
    <StandInMemoryRules
      {...props}
      fixedScope={{ kind: 'project', id: 'project', store: 'local' }}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-memory-rules-toggle'))
  expect(await screen.findByText('暂无遗忘规则。')).toBeVisible()
  view.rerender(<StandInMemoryRules {...props} />)
  expect(await screen.findByTestId('stand-in-memory-rule')).toHaveTextContent('旧版遗忘指纹')
  expect(screen.getByTestId('stand-in-memory-rule')).toHaveTextContent('abcdef123456')
  expect(props.label).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-memory-rule-delete'))
  expect(screen.getByText(/仅移除这个旧指纹/)).toBeVisible()
  expect(deleteMemoryRule).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-memory-rule-delete-confirm'))
  expect(deleteMemoryRule).toHaveBeenCalledExactlyOnceWith(7, 'mac', legacy.id, 1, legacy.updatedAt)
  expect(await screen.findByText('暂无遗忘规则。')).toBeVisible()
})

it('hides old account rules immediately and ignores late responses from that account', async () => {
  let resolveOld!: (rows: StandInMemoryRule[]) => void
  const pending = new Promise<StandInMemoryRule[]>(resolve => {
    resolveOld = resolve
  })
  const memoryRules = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce([rule('new-account')])
  const props = {
    api: { memoryRules } as unknown as StandInExecutorApi,
    userId: 7,
    deviceId: 'mac',
    label: () => 'scope',
    refreshKey: 0,
    disabled: false,
    onBusyChange: vi.fn(),
  }
  const view = render(<StandInMemoryRules {...props} />)
  await userEvent.setup().click(screen.getByTestId('stand-in-memory-rules-toggle'))
  view.rerender(<StandInMemoryRules {...props} userId={8} />)
  expect(await screen.findByTestId('stand-in-memory-rule')).toHaveTextContent('new-account')
  await act(async () => resolveOld([rule('private-old-account')]))
  expect(screen.queryByText('private-old-account')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-memory-rule')).toHaveTextContent('new-account')
})

it('shows only the exact project store and hides a previous scope on scope change', async () => {
  const memoryRules = vi.fn(async () => [
    {
      ...rule('local-project'),
      scope: { kind: 'project' as const, id: 'same', store: 'local' as const },
    },
    {
      ...rule('cloud-project'),
      scope: { kind: 'project' as const, id: 'same', store: 'cloud' as const },
    },
    rule('personal'),
  ])
  const props = {
    api: { memoryRules } as unknown as StandInExecutorApi,
    userId: 7,
    deviceId: 'mac',
    label: () => 'scope',
    refreshKey: 0,
    disabled: false,
    onBusyChange: vi.fn(),
  }
  const view = render(
    <StandInMemoryRules {...props} fixedScope={{ kind: 'project', id: 'same', store: 'local' }} />
  )
  await userEvent.setup().click(screen.getByTestId('stand-in-memory-rules-toggle'))
  expect(await screen.findByTestId('stand-in-memory-rule')).toHaveTextContent('local-project')
  expect(screen.queryByText('cloud-project')).not.toBeInTheDocument()
  expect(screen.queryByText('personal')).not.toBeInTheDocument()
  view.rerender(
    <StandInMemoryRules {...props} fixedScope={{ kind: 'project', id: 'same', store: 'cloud' }} />
  )
  expect(screen.queryByText('local-project')).not.toBeInTheDocument()
  expect(await screen.findByTestId('stand-in-memory-rule')).toHaveTextContent('cloud-project')
})
