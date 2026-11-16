import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInProposal } from '@/api/standIn'
import '@/i18n'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { StandInProposalCard } from './StandInProposalCard'

function fixture() {
  const connection = {
    id: 'group',
    profile: 'corp',
    kind: 'group' as const,
    name: 'Development group',
    policy: { automatic: true, askBeforeAct: true },
  }
  const current: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'mac',
    version: 3,
    roles: [],
    primary: {
      enabled: true,
      prompt: 'Shared instructions',
      preferences: '',
      connections: [connection],
    },
  }
  const settings = {
    ...current,
    primary: { ...current.primary!, connections: [] },
    roles: [
      {
        ...newStandInRole('mac', 'reply'),
        name: 'Reply role',
        enabled: true,
        prompt: 'Handle group mentions only',
        connections: [connection],
      },
    ],
  }
  return {
    current,
    proposal: { settings, summary: 'Move group replies to a dedicated role' } as StandInProposal,
    busy: false,
    projects: [],
    onResolve: vi.fn(async () => {}),
  }
}

it('names each changed identity and shows added and removed connections without dumping unchanged primary settings', async () => {
  const props = fixture()
  render(<StandInProposalCard {...props} />)
  expect(screen.getByText('新建角色：Reply role')).toBeInTheDocument()
  expect(screen.getByText('调整主助理')).toBeInTheDocument()
  expect(screen.getByText('新增连接：')).toBeInTheDocument()
  expect(screen.getByText('移除连接：')).toBeInTheDocument()
  expect(screen.queryByText('Shared instructions')).not.toBeInTheDocument()
  const body = screen.getByTestId('stand-in-proposal-details')
  expect(body).toHaveClass('overflow-y-auto')
  expect(within(body).queryByTestId('stand-in-proposal-accept')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-proposal')).not.toHaveClass('overflow-y-auto')
  await userEvent.click(screen.getByTestId('stand-in-proposal-accept'))
  expect(props.onResolve).toHaveBeenCalledWith(true)
})

it('blocks a stale proposal while keeping the reject action available', async () => {
  const props = fixture()
  props.current.version = 4
  render(<StandInProposalCard {...props} />)
  expect(screen.getByTestId('stand-in-proposal-accept')).toBeDisabled()
  expect(screen.getByText('配置已发生变化，请让助理基于最新设置重新整理。')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('stand-in-proposal-reject'))
  expect(props.onResolve).toHaveBeenCalledWith(false)
})

it('shows the complete collection configuration change without exposing opaque keys', () => {
  const props = fixture()
  const source = props.current.primary!.connections![0]!
  Object.assign(source, { collectionKey: 'opaque-before', configurationSummary: 'Items #1, #2' })
  props.proposal.settings = {
    ...props.current,
    primary: {
      ...props.current.primary!,
      connections: [
        { ...source, collectionKey: 'opaque-after', configurationSummary: 'Items #3, #4' },
      ],
    },
  }
  render(<StandInProposalCard {...props} />)
  const change = screen.getByTestId('stand-in-proposal-connection-configuration')
  expect(change).toHaveTextContent('修改前：Items #1, #2 → 修改后：Items #3, #4')
  expect(screen.queryByText(/opaque-before|opaque-after/)).not.toBeInTheDocument()
})

it('describes a legacy connection with the generic default scope', () => {
  const props = fixture()
  const source = props.current.primary!.connections![0]!
  props.proposal.settings = {
    ...props.current,
    primary: {
      ...props.current.primary!,
      connections: [
        { ...source, configurationSummary: 'Selected item #3', collectionKey: 'opaque-selection' },
      ],
    },
  }
  render(<StandInProposalCard {...props} />)
  expect(screen.getByTestId('stand-in-proposal-connection-configuration')).toHaveTextContent(
    '修改前：默认范围 → 修改后：Selected item #3'
  )
})

it('shows the saved result without actions or unrelated version-only role changes', () => {
  const props = fixture()
  const unchanged = { ...newStandInRole('mac', 'unchanged'), name: 'Unchanged role', version: 1 }
  props.current.roles.push(unchanged)
  props.proposal.settings.roles.push({ ...unchanged, version: 2 })
  render(<StandInProposalCard {...props} result="accepted" />)
  expect(screen.getByTestId('stand-in-proposal-result')).toHaveTextContent('配置已应用')
  expect(screen.getByText('新建角色：Reply role')).toBeInTheDocument()
  expect(screen.queryByText(/Unchanged role/)).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-proposal-accept')).not.toBeInTheDocument()
  expect(props.onResolve).not.toHaveBeenCalled()
})
