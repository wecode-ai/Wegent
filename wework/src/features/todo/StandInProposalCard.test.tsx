import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInProposal } from '@/api/standIn'
import '@/i18n'
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
    autoSelect: false,
    roles: [],
    primary: {
      enabled: true,
      prompt: 'Shared instructions',
      preferences: '',
      dingtalk: [connection],
    },
  }
  const settings = {
    ...current,
    primary: { ...current.primary!, dingtalk: [] },
    roles: [
      {
        ...newStandInRole('mac', 'reply'),
        name: 'Reply role',
        enabled: true,
        prompt: 'Handle group mentions only',
        dingtalk: [connection],
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
  expect(screen.getByText('调整主分身')).toBeInTheDocument()
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
  expect(screen.getByText('配置已发生变化，请让分身基于最新设置重新整理。')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('stand-in-proposal-reject'))
  expect(props.onResolve).toHaveBeenCalledWith(false)
})
