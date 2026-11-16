import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { newStandInRole } from '@/api/personalStandIn'
import '@/i18n'
import { StandInProposalSources } from './StandInProposalSources'

it('shows the removed and added exclusions when reviewing a blacklist change', () => {
  const source = {
    providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
    profile: 'corp',
    kind: 'group',
    id: '*',
    scope: 'all' as const,
    name: 'All groups',
    policy: { automatic: true, askBeforeAct: true },
    excludedResources: [{ id: 'old', name: 'Old excluded group' }],
  }
  const previous = { ...newStandInRole('device'), connections: [source] }
  const identity = {
    ...previous,
    connections: [{ ...source, excludedResources: [{ id: 'new', name: 'New excluded group' }] }],
  }
  render(<StandInProposalSources identity={identity} previous={previous} projects={[]} />)
  const summary = screen.getByTestId('stand-in-proposal-connection-configuration')
  expect(summary).toHaveTextContent('Old excluded group')
  expect(summary).toHaveTextContent('New excluded group')
})
