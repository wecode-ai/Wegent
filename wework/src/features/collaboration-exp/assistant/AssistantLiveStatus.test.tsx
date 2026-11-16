import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import english from '@/i18n/locales/en/collaborationExp.json'
import chinese from '@/i18n/locales/zh-CN/collaborationExp.json'
import type { ExperienceTeamRelayNode, ExperienceWorkSnapshot } from '../model'
import { AssistantWorkSnapshot } from './AssistantWorkSnapshot'
import { TeamRelay } from './TeamRelay'

let messages: typeof english = english

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      const text = key
        .split('.')
        .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], messages)
      return String(text).replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(values[name] ?? '')
      )
    },
  }),
}))

beforeEach(() => {
  messages = english
})
afterEach(cleanup)

const nodes: ExperienceTeamRelayNode[] = [
  {
    id: 'reviewer',
    name: 'Reviewer',
    enabled: true,
    isDefault: false,
    state: 'running',
    counts: { waiting: 0, running: 1, completed: 4 },
  },
]

const snapshot: ExperienceWorkSnapshot = {
  counts: { waiting: 2, running: 1, completed: 4 },
  current: {
    key: 'current',
    title: 'Review task',
    state: 'running',
    roleIds: ['reviewer'],
    updatedAt: '',
    address: { deviceId: 'device-one', taskId: 'task-one' },
  },
  items: [],
  team: nodes,
}

it('announces changing work counts politely without including the current-work button', () => {
  const open = vi.fn()
  const { rerender } = render(<AssistantWorkSnapshot snapshot={snapshot} ready onOpen={open} />)
  const status = screen.getByRole('status')
  expect(status).toHaveAttribute('aria-live', 'polite')
  expect(status).toHaveAttribute('aria-atomic', 'true')
  expect(status).toHaveTextContent(
    'Current work: 2 awaiting a decision, 1 in progress, 4 completed.'
  )
  expect(within(status).queryByRole('button')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('collaboration-exp-assistant-current'))
  expect(open).toHaveBeenCalledWith(snapshot.current)

  rerender(
    <AssistantWorkSnapshot
      snapshot={{ ...snapshot, counts: { waiting: 1, running: 0, completed: 6 } }}
      ready
      onOpen={open}
    />
  )
  expect(screen.getByRole('status')).toBe(status)
  expect(status).toHaveTextContent(
    'Current work: 1 awaiting a decision, 0 in progress, 6 completed.'
  )
})

it('announces localized verified work counts and leaves unconfirmed counts unannounced', () => {
  messages = chinese
  const { rerender } = render(
    <AssistantWorkSnapshot snapshot={snapshot} ready={false} onOpen={vi.fn()} />
  )
  const status = screen.getByRole('status')
  expect(status).toBeEmptyDOMElement()
  rerender(<AssistantWorkSnapshot snapshot={snapshot} ready onOpen={vi.fn()} />)
  expect(status).toHaveTextContent('当前工作：2 件待决，1 件推进中，4 件已完成。')
})

it('announces team member state and counts outside configuration controls', () => {
  const { rerender } = render(<TeamRelay nodes={nodes} onManage={vi.fn()} />)
  const status = screen.getByRole('status')
  expect(status).toHaveAttribute('aria-live', 'polite')
  expect(status).toHaveAttribute('aria-atomic', 'true')
  expect(status).toHaveTextContent(
    'Assistant team: Reviewer: In progress. 0 awaiting confirmation, 1 in progress, 4 completed.'
  )
  expect(within(status).queryByRole('button')).not.toBeInTheDocument()
  rerender(
    <TeamRelay
      nodes={[
        {
          ...nodes[0],
          enabled: false,
          state: 'waiting',
          counts: { waiting: 2, running: 0, completed: 5 },
        },
      ]}
      onManage={vi.fn()}
    />
  )
  expect(screen.getByRole('status')).toBe(status)
  expect(status).toHaveTextContent(
    'Reviewer: Awaiting confirmation · Paused. 2 awaiting confirmation, 0 in progress, 5 completed.'
  )
})

it('announces localized team readiness without exposing unconfirmed counts', () => {
  messages = chinese
  const { rerender } = render(<TeamRelay nodes={nodes} ready={false} onManage={vi.fn()} />)
  const status = screen.getByRole('status')
  expect(status).toHaveTextContent('状态尚未确认')
  expect(status).not.toHaveTextContent('4')
  rerender(<TeamRelay nodes={nodes} ready onManage={vi.fn()} />)
  expect(status).toHaveTextContent('助理团：Reviewer：推进中。0 件待确认，1 件推进中，4 件已完成。')
})

it('announces aggregate counts once when the snapshot and member relay appear together', () => {
  render(
    <>
      <AssistantWorkSnapshot snapshot={snapshot} ready onOpen={vi.fn()} />
      <TeamRelay nodes={nodes} announceCounts={false} onManage={vi.fn()} />
    </>
  )
  const statuses = screen.getAllByRole('status')
  expect(statuses).toHaveLength(2)
  expect(statuses[0]).toHaveTextContent(
    'Current work: 2 awaiting a decision, 1 in progress, 4 completed.'
  )
  expect(statuses[1]).toHaveTextContent('Assistant team: Reviewer: In progress.')
  expect(statuses[1]).not.toHaveTextContent(/\d/)
  for (const status of statuses) {
    expect(within(status).queryByRole('button')).not.toBeInTheDocument()
  }
})
