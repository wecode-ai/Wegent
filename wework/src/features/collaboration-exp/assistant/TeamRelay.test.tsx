import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import english from '@/i18n/locales/en/collaborationExp.json'
import type { ExperienceTeamRelayNode } from '../model'
import { TeamRelay } from './TeamRelay'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      const text = key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)[part],
          english
        ) as string
      return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''))
    },
  }),
}))

afterEach(cleanup)

const nodes: ExperienceTeamRelayNode[] = [
  {
    id: null,
    name: null,
    enabled: true,
    isDefault: true,
    state: 'waiting',
    counts: { waiting: 2, running: 0, completed: 1 },
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    enabled: true,
    isDefault: false,
    state: 'running',
    counts: { waiting: 0, running: 1, completed: 0 },
  },
  {
    id: 'archivist',
    name: 'Archivist',
    enabled: false,
    isDefault: false,
    state: 'idle',
    counts: { waiting: 0, running: 0, completed: 3 },
  },
]

it('names each real team state without relying on color or motion', () => {
  render(<TeamRelay nodes={nodes} onManage={vi.fn()} />)
  expect(
    screen.getByRole('button', {
      name: 'Default assistant · Awaiting confirmation · 2 · Configure assistant',
    })
  ).toHaveTextContent('Awaiting confirmation · 2')
  expect(
    screen.getByRole('button', { name: 'Reviewer · In progress · 1 · Configure assistant' })
  ).toHaveTextContent('In progress · 1')
  expect(
    screen.getByRole('button', { name: 'Archivist · Standing by · Paused · Configure assistant' })
  ).toHaveTextContent('Standing by · Paused')
  expect(screen.getByTestId('collaboration-exp-team-relay-node-archivist')).toHaveAttribute(
    'data-completed-count',
    '3'
  )
  expect(screen.queryByText(/online/i)).not.toBeInTheDocument()
  for (const [id, state] of [
    ['@primary', 'waiting'],
    ['reviewer', 'running'],
    ['archivist', 'idle'],
  ]) {
    expect(screen.getByTestId(`collaboration-exp-team-relay-status-${id}`)).toHaveAttribute(
      'data-state',
      state
    )
  }
  expect(screen.getByTestId('collaboration-exp-team-relay-node-@primary')).toHaveAttribute(
    'title',
    'Default assistant · Awaiting confirmation · 2'
  )
})

it('keeps an unknown status marker and semantic label while native work is not ready', () => {
  render(<TeamRelay nodes={nodes} ready={false} onManage={vi.fn()} />)
  for (const id of ['@primary', 'reviewer', 'archivist']) {
    expect(screen.getByTestId(`collaboration-exp-team-relay-status-${id}`)).toHaveAttribute(
      'data-state',
      'unknown'
    )
    expect(screen.getByTestId(`collaboration-exp-team-relay-node-${id}`)).toHaveAccessibleName(
      /Status not confirmed/
    )
    expect(screen.getByTestId(`collaboration-exp-team-relay-node-${id}`)).not.toHaveAttribute(
      'data-running-count'
    )
  }
})

it('opens existing management with the exact role identity and exposes all compacted members', () => {
  const manage = vi.fn()
  render(
    <TeamRelay
      nodes={[...nodes, { ...nodes[2], id: 'extra-one' }, { ...nodes[2], id: 'extra-two' }]}
      onManage={manage}
    />
  )
  fireEvent.click(screen.getByTestId('collaboration-exp-team-relay-node-reviewer'))
  expect(manage).toHaveBeenLastCalledWith('reviewer')
  fireEvent.click(screen.getByTestId('collaboration-exp-team-relay-node-@primary'))
  expect(manage).toHaveBeenLastCalledWith(undefined)
  fireEvent.click(screen.getByRole('button', { name: 'View all 5 assistants' }))
  expect(manage).toHaveBeenLastCalledWith()
})

it('preserves an unknown team instead of inventing a standing-by default assistant', () => {
  render(<TeamRelay nodes={[]} onManage={vi.fn()} />)
  expect(screen.getByTestId('collaboration-exp-team-relay-unavailable')).toHaveTextContent(
    'not available yet'
  )
  expect(screen.queryByTestId('collaboration-exp-team-relay-node-@primary')).not.toBeInTheDocument()
})

it('keeps the primary and a native default role uniquely addressable and opens their own settings', () => {
  const manage = vi.fn()
  render(
    <TeamRelay
      nodes={[
        nodes[0],
        {
          ...nodes[2],
          id: 'default',
          name: 'Development',
        },
      ]}
      onManage={manage}
    />
  )
  const primary = screen.getByTestId('collaboration-exp-team-relay-node-@primary')
  const specialist = screen.getByTestId('collaboration-exp-team-relay-node-default')
  expect(primary).toHaveAttribute('data-assistant-id', '@primary')
  expect(specialist).toHaveAttribute('data-assistant-id', 'default')
  expect(primary).toHaveTextContent('Default assistant')
  expect(specialist).toHaveTextContent('Development')
  fireEvent.click(primary)
  expect(manage).toHaveBeenLastCalledWith(undefined)
  fireEvent.click(specialist)
  expect(manage).toHaveBeenLastCalledWith('default')
})
