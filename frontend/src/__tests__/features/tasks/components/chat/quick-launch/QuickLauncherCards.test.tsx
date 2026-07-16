// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { QuickLauncherCards } from '@/features/tasks/components/chat/quick-launch/quick-launcher-cards'
import type { QuickLauncher } from '@/features/tasks/components/chat/quick-launch/types'
import type { Team } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string) => {
      if (namespace !== 'chat') {
        return key
      }

      const translations: Record<string, string> = {
        'quick_launch.system_functions': 'Recommended features',
        'quick_launch.favorite_agents': 'My favorites',
      }

      return translations[key] || key
    },
  }),
}))

const makeTeam = (overrides: Partial<Team> = {}): Team => ({
  id: 1,
  name: 'team',
  namespace: 'default',
  description: 'Team description',
  bots: [],
  workflow: { mode: 'pipeline' },
  is_active: true,
  user_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  bind_mode: ['chat'],
  ...overrides,
})

const makeLauncher = (overrides: Partial<QuickLauncher>): QuickLauncher => ({
  type: 'system_function',
  key: 'system:create_ppt',
  title: 'Create PPT',
  inputPresets: [],
  team: makeTeam(),
  targetPage: 'chat',
  ...overrides,
})

describe('QuickLauncherCards', () => {
  test('renders quick launch row titles from the chat namespace', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          makeLauncher({
            key: 'system:create_ppt',
            team: makeTeam({ id: 1 }),
            title: 'Create PPT',
          }),
        ]}
        favoriteLaunchers={[
          makeLauncher({
            type: 'favorite_agent',
            key: 'agent:2',
            team: makeTeam({ id: 2 }),
            title: 'Writing Agent',
          }),
        ]}
        onSelectLauncher={jest.fn()}
      />
    )

    expect(screen.getByTestId('quick-launch-system-row')).toHaveTextContent('Recommended features')
    expect(screen.getByTestId('quick-launch-favorites-row')).toHaveTextContent('My favorites')
    expect(screen.queryByText('quick_launch.favorite_agents')).not.toBeInTheDocument()
  })

  test('left aligns launcher cards in each row', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          makeLauncher({
            key: 'system:create_ppt',
            title: 'Create PPT',
          }),
        ]}
        favoriteLaunchers={[]}
        onSelectLauncher={jest.fn()}
      />
    )

    expect(screen.getByTestId('quick-launch-system-grid')).toHaveClass('justify-start')
    expect(screen.queryByTestId('quick-launch-system-grid')).not.toHaveClass('justify-center')
  })

  test('renders launcher cards with title and description', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          makeLauncher({
            key: 'system:video_summary',
            title: 'Analyze Weibo video',
            description: 'Analyze this Weibo video and summarize the author viewpoint',
          }),
        ]}
        favoriteLaunchers={[]}
        onSelectLauncher={jest.fn()}
      />
    )

    const systemCard = screen.getByTestId('quick-launcher-system_function-system-video_summary')

    expect(systemCard).toHaveTextContent('Analyze Weibo video')
    expect(systemCard).toHaveTextContent(
      'Analyze this Weibo video and summarize the author viewpoint'
    )
  })

  test('supports horizontal scrolling for both launcher rows without inline arrow slots', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          makeLauncher({ key: 'system:create_ppt', title: 'Create PPT' }),
          makeLauncher({ key: 'system:create_skill', title: 'Create Skill' }),
        ]}
        favoriteLaunchers={[
          makeLauncher({
            type: 'favorite_agent',
            key: 'agent:2',
            team: makeTeam({ id: 2 }),
            title: 'Writing Agent',
          }),
          makeLauncher({
            type: 'favorite_agent',
            key: 'agent:3',
            team: makeTeam({ id: 3 }),
            title: 'Docs Agent',
          }),
        ]}
        onSelectLauncher={jest.fn()}
      />
    )

    for (const grid of [
      screen.getByTestId('quick-launch-system-grid'),
      screen.getByTestId('quick-launch-favorites-grid'),
    ]) {
      expect(grid).toHaveClass('flex-nowrap')
      expect(grid).toHaveClass('overflow-x-auto')
      expect(grid).toHaveClass('scrollbar-hide')
      expect(grid).not.toHaveClass('flex-wrap')
    }

    expect(screen.getByTestId('quick-launch-system-grid-track')).toHaveClass('relative')
    expect(screen.getByTestId('quick-launch-favorites-grid-track')).toHaveClass('relative')
    expect(screen.queryByTestId('quick-launch-system-grid-scroll-left')).not.toBeInTheDocument()
    expect(screen.queryByTestId('quick-launch-favorites-grid-scroll-left')).not.toBeInTheDocument()
  })

  test('shows flat fade overlay arrows only for available scroll directions', async () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          makeLauncher({ key: 'system:create_ppt', title: 'Create PPT' }),
          makeLauncher({ key: 'system:create_skill', title: 'Create Skill' }),
          makeLauncher({ key: 'system:create_task', title: 'Create Task' }),
        ]}
        favoriteLaunchers={[]}
        onSelectLauncher={jest.fn()}
      />
    )

    const grid = screen.getByTestId('quick-launch-system-grid')
    Object.defineProperty(grid, 'scrollWidth', { configurable: true, value: 600 })
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 300 })
    Object.defineProperty(grid, 'scrollLeft', { configurable: true, writable: true, value: 0 })

    fireEvent.scroll(grid)

    expect(screen.queryByTestId('quick-launch-system-grid-scroll-left')).not.toBeInTheDocument()
    const rightButton = await screen.findByTestId('quick-launch-system-grid-scroll-right')
    expect(rightButton).toHaveClass('absolute')
    expect(rightButton).toHaveClass('right-0')
    expect(rightButton).toHaveClass('h-full', 'w-12', 'bg-gradient-to-l')
    expect(rightButton).not.toHaveClass('rounded-full')

    Object.defineProperty(grid, 'scrollLeft', { configurable: true, writable: true, value: 120 })
    fireEvent.scroll(grid)

    await waitFor(() => {
      expect(screen.getByTestId('quick-launch-system-grid-scroll-left')).toBeInTheDocument()
    })
    expect(screen.getByTestId('quick-launch-system-grid-scroll-left')).toHaveClass('absolute')
    expect(screen.getByTestId('quick-launch-system-grid-scroll-left')).toHaveClass(
      'bg-gradient-to-r'
    )

    Object.defineProperty(grid, 'scrollLeft', { configurable: true, writable: true, value: 300 })
    fireEvent.scroll(grid)

    await waitFor(() => {
      expect(screen.queryByTestId('quick-launch-system-grid-scroll-right')).not.toBeInTheDocument()
    })
  })

  test('keeps more and create cards outside the horizontally scrolling favorites area', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[]}
        favoriteLaunchers={[
          makeLauncher({
            type: 'favorite_agent',
            key: 'agent:2',
            team: makeTeam({ id: 2 }),
            title: 'Writing Agent',
          }),
        ]}
        onSelectLauncher={jest.fn()}
        renderMoreButton={() => (
          <button type="button" data-testid="quick-launch-more-card">
            More
          </button>
        )}
        renderQuickCreateCard={() => (
          <button type="button" data-testid="quick-launch-create-card">
            Create
          </button>
        )}
      />
    )

    const favoritesGrid = screen.getByTestId('quick-launch-favorites-grid')
    const actions = screen.getByTestId('quick-launch-favorites-actions')
    const moreCard = screen.getByTestId('quick-launch-more-card')
    const createCard = screen.getByTestId('quick-launch-create-card')

    expect(favoritesGrid).not.toContainElement(moreCard)
    expect(favoritesGrid).not.toContainElement(createCard)
    expect(actions).toContainElement(moreCard)
    expect(actions).toContainElement(createCard)
  })

  test('uses the main branch rounded card shape', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          makeLauncher({
            key: 'system:create_ppt',
            title: 'Create PPT',
          }),
        ]}
        favoriteLaunchers={[]}
        onSelectLauncher={jest.fn()}
      />
    )

    const systemCard = screen.getByTestId('quick-launcher-system_function-system-create_ppt')

    expect(systemCard).toHaveStyle({ borderRadius: '20px' })
  })

  test('uses neutral card colors for unselected system functions', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          makeLauncher({
            key: 'system:create_ppt',
            title: 'Create PPT',
          }),
        ]}
        favoriteLaunchers={[]}
        onSelectLauncher={jest.fn()}
      />
    )

    const systemCard = screen.getByTestId('quick-launcher-system_function-system-create_ppt')

    expect(systemCard).toHaveClass('border-border')
    expect(systemCard).toHaveClass('bg-base')
    expect(systemCard).not.toHaveClass('bg-primary/5')
    expect(systemCard).not.toHaveClass('border-primary/25')
  })

  test('shows the main branch selected state for the active launcher', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          makeLauncher({
            key: 'system:create_ppt',
            title: 'Create PPT',
          }),
        ]}
        favoriteLaunchers={[]}
        selectedLauncherKey="system:create_ppt"
        onSelectLauncher={jest.fn()}
      />
    )

    const systemCard = screen.getByTestId('quick-launcher-system_function-system-create_ppt')

    expect(systemCard).toHaveClass('border-l-[3px]')
    expect(systemCard).toHaveClass('border-l-primary')
    expect(systemCard).toHaveClass('bg-primary/5')
    expect(screen.getByText('Create PPT')).toHaveClass('text-primary')
  })
})
