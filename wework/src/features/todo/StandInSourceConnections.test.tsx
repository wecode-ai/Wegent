import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { expect, test } from 'vitest'
import {
  newStandInPrimaryRole,
  STAND_IN_DINGTALK_PROVIDER,
  type StandInRole,
  type StandInSourceConnection,
} from '@/api/personalStandIn'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'
import { ConnectionScopeNavigation } from './connectionScopeNavigation'
import { StandInSourceConnections } from './StandInSourceConnections'

test('adds or edits one DingTalk scope at a time without changing another account', () => {
  const base = {
    providerId: STAND_IN_DINGTALK_PROVIDER,
    profile: 'work',
    id: '*',
    scope: 'all' as const,
    policy: { automatic: true, askBeforeAct: true },
  }
  const sources: StandInSourceConnection[] = [
    {
      ...base,
      kind: 'group',
      name: 'Groups',
      collectionKey: 'all-messages',
      excludedResources: [{ id: 'excluded-group', name: 'Excluded group' }],
    },
    { ...base, kind: 'direct', name: 'Other account', profile: 'previous' },
    { ...base, kind: 'direct', name: 'Contacts' },
  ]
  const { services } = personalStandInFixture()
  const api = services.standInApi!
  let draft: StandInRole = { ...newStandInPrimaryRole('local'), connections: sources }
  function Editor() {
    const [role, setRole] = useState(draft)
    const scopeBack = useRef<(() => void) | null>(null)
    return (
      <ConnectionScopeNavigation value={{ back: scopeBack, setTitle: () => {} }}>
        <button type="button" onClick={() => scopeBack.current?.()}>
          Back
        </button>
        <StandInSourceConnections
          role={role}
          provider={{
            id: STAND_IN_DINGTALK_PROVIDER,
            displayName: 'DingTalk',
            resourceKinds: ['group', 'direct'],
            allResourceKinds: ['group', 'direct'],
            dependencies: [],
            availability: { status: 'ready', profile: 'work' },
          }}
          deviceId="local"
          localDeviceId="local"
          disabled={false}
          api={api}
          onChange={next => {
            draft = next
            setRole(next)
          }}
        />
      </ConnectionScopeNavigation>
    )
  }
  render(<Editor />)
  expect(screen.queryByTestId('stand-in-dingtalk-query')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-dingtalk-kind-group')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-open-scope-group-*'))
  expect(screen.getByTestId('stand-in-dingtalk-result-excluded-group')).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(draft.connections).toEqual(sources)
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-add-scope'))
  expect(screen.queryByTestId('stand-in-dingtalk-query')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-scope-all'))
  expect(screen.queryByTestId('stand-in-dingtalk-query')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-dingtalk-scope-all-direct')).not.toBeInTheDocument()
  const group = draft.connections?.find(row => row.profile === 'work' && row.kind === 'group')
  expect(group).toMatchObject({ id: '*', scope: 'all', collectionKey: 'all-messages' })
  expect(group?.excludedResources).toBeUndefined()
  expect(draft.connections?.some(row => row.profile === 'work' && row.kind === 'direct')).toBe(true)
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-open-all-scope'))
  fireEvent.click(screen.getByTestId('stand-in-processing-settings-toggle'))
  expect(screen.getByTestId('stand-in-dingtalk-policy-all-messages')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-kind-group'))
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-remove-kind-scope'))
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-open-scope-direct-*'))
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-remove-kind-scope'))
  expect(draft.connections).toEqual([sources[1]])
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-add-scope'))
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-kind-direct'))
  expect(screen.queryByTestId('stand-in-dingtalk-query')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-dingtalk-kind-group')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-choose-selected'))
  expect(screen.getByTestId('stand-in-dingtalk-query')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByTestId('stand-in-dingtalk-kind-group')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(draft.connections).toEqual([sources[1]])
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-add-scope'))
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-scope-all'))
  fireEvent.click(screen.getByTestId('stand-in-dingtalk-open-all-scope-remove'))
  expect(draft.connections).toEqual([sources[1]])
})
