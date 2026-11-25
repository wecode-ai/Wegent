import { act, fireEvent, render, screen } from '@testing-library/react'
import { teamApis } from '@/apis/team'
import { QuickLaunchPanel } from '@/features/tasks/components/chat/quick-launch/quick-launch-panel'
import type { QuickLauncher } from '@/features/tasks/components/chat/quick-launch/types'
import type { Team } from '@/types/api'

const mockLauncher: QuickLauncher = {
  key: 'agent:41',
  type: 'favorite_agent',
  title: 'First agent',
  team: { id: 41, bind_mode: ['chat'] },
  targetPage: 'chat',
  inputPresets: [],
}

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock('@/apis/team', () => ({ teamApis: { getTeam: jest.fn() } }))
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/features/tasks/components/chat/quick-launch/useQuickLaunchers', () => ({
  useQuickLaunchers: () => ({
    isLoading: false,
    systemLaunchers: [],
    favoriteLaunchers: [mockLauncher],
  }),
}))
jest.mock('@/features/tasks/components/chat/quick-launch/quick-launcher-cards', () => ({
  QuickLauncherCards: ({
    onSelectLauncher,
  }: {
    onSelectLauncher: (item: QuickLauncher) => void
  }) => <button onClick={() => onSelectLauncher(mockLauncher)}>First agent</button>,
}))

beforeEach(() => jest.clearAllMocks())

it.each([42, null])('ignores late details after an external selection changes to %s', async id => {
  let resolveTeam!: (team: Team) => void
  jest.mocked(teamApis.getTeam).mockReturnValue(
    new Promise(resolve => {
      resolveTeam = resolve
    })
  )
  const props = {
    teams: [],
    selectedTeam: { id: 7 } as Team,
    onTeamSelect: jest.fn(),
    onPresetSelect: jest.fn(),
    currentMode: 'chat' as const,
  }
  const { rerender } = render(<QuickLaunchPanel {...props} />)
  fireEvent.click(screen.getByText('First agent'))
  expect(teamApis.getTeam).toHaveBeenCalledWith(41)
  rerender(<QuickLaunchPanel {...props} selectedTeam={id === null ? null : ({ id } as Team)} />)

  await act(async () => resolveTeam({ id: 41 } as Team))

  expect(props.onTeamSelect).not.toHaveBeenCalled()
  expect(props.onPresetSelect).not.toHaveBeenCalled()
})

it('keeps a pending selection when only the catalog updates', async () => {
  let resolveTeam!: (team: Team) => void
  jest.mocked(teamApis.getTeam).mockReturnValue(
    new Promise(resolve => {
      resolveTeam = resolve
    })
  )
  const props = {
    teams: [],
    selectedTeam: { id: 7 } as Team,
    onTeamSelect: jest.fn(),
    onPresetSelect: jest.fn(),
    currentMode: 'chat' as const,
  }
  const { rerender } = render(<QuickLaunchPanel {...props} />)
  fireEvent.click(screen.getByText('First agent'))
  rerender(<QuickLaunchPanel {...props} teams={[{ id: 7 } as Team]} />)
  const team = { id: 41 } as Team

  await act(async () => resolveTeam(team))

  expect(props.onTeamSelect).toHaveBeenCalledTimes(1)
  expect(props.onTeamSelect).toHaveBeenCalledWith(team)
})
