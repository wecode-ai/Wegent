// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'

import { FeaturedScenarios } from '@/features/resource-library/components/FeaturedScenarios'

const mockPush = jest.fn()

jest.mock('@/apis/user', () => ({
  userApis: {
    getQuickLaunch: jest.fn().mockResolvedValue({
      system_functions: [
        {
          type: 'system_function',
          id: 'research',
          team_id: 1,
          name: 'research',
          title: 'Research Agent',
          description: 'Research complex topics',
          icon: '/marketplace-icons/research.png',
          cover: '/marketplace-covers/research.webp',
          recommended_mode: 'both',
          enabled: true,
          order: 1,
          input_presets: [],
        },
        {
          type: 'system_function',
          id: 'coder',
          team_id: 2,
          name: 'coder',
          title: 'Coding Agent',
          description: 'Build software',
          recommended_mode: 'code',
          bind_mode: [],
          enabled: true,
          order: 2,
          input_presets: [
            { id: 'review', title: 'Review code' },
            { id: 'test', title: 'Write tests' },
            { id: 'explain', title: 'Explain this module' },
          ],
        },
        {
          type: 'system_function',
          id: 'image',
          team_id: 3,
          name: 'image',
          title: 'Image Agent',
          recommended_mode: 'chat',
          bind_mode: ['image'],
          enabled: true,
          order: 3,
          input_presets: [{ id: 'draw', title: 'Draw an image' }],
        },
        {
          type: 'system_function',
          id: 'video',
          team_id: 4,
          name: 'video',
          title: 'Video Agent',
          recommended_mode: 'chat',
          bind_mode: ['video'],
          enabled: true,
          order: 4,
          input_presets: [{ id: 'create', title: 'Create a video' }],
        },
      ],
      favorite_agents: [],
    }),
  },
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('FeaturedScenarios', () => {
  it('renders the same system recommendations as quick launch', async () => {
    render(<FeaturedScenarios />)

    expect(screen.queryByTestId('featured-scenarios')).not.toBeInTheDocument()
    expect(await screen.findByTestId('featured-agent-research')).toHaveTextContent('Research Agent')
    expect(screen.getByTestId('featured-scenarios')).toBeInTheDocument()
    expect(screen.getByTestId('featured-scenarios-scroll')).toHaveClass('items-start', 'pt-1')
    expect(screen.getByTestId('featured-agent-coder')).toHaveTextContent('Coding Agent')
    expect(screen.getByTestId('featured-agent-coder')).not.toHaveTextContent('Build software')
    expect(screen.getByTestId('featured-agent-coder')).not.toHaveTextContent(
      'featured_scenarios.official_recommendation'
    )
    expect(screen.getByTestId('featured-agent-coder-open')).not.toHaveClass('min-h-28')
    expect(screen.getByTestId('featured-agent-research')).not.toHaveClass('hover:-translate-y-0.5')
    expect(screen.getByTestId('featured-agent-research-cover')).toHaveAttribute(
      'src',
      '/marketplace-covers/research.webp'
    )
    expect(screen.getByTestId('featured-agent-research-cover')).toHaveClass(
      'absolute',
      'inset-0',
      'h-full',
      'w-full'
    )
    expect(screen.getByTestId('featured-agent-research-cover')).not.toHaveClass(
      'group-hover/card:scale-[1.03]'
    )
    expect(
      within(screen.getByTestId('featured-agent-research')).getByTestId('resource-icon')
    ).toHaveAttribute('data-icon-source', 'image')
    expect(
      within(screen.getByTestId('featured-agent-coder')).getByTestId('resource-icon')
    ).toHaveAttribute('data-icon-source', 'initial')
    expect(screen.queryByTestId('featured-agent-coder-cover')).not.toBeInTheDocument()
    expect(screen.getByTestId('featured-agent-coder')).toHaveTextContent('Review code')
    expect(screen.getByTestId('featured-agent-coder')).toHaveTextContent('Write tests')
    expect(screen.getByTestId('featured-agent-coder')).not.toHaveTextContent('Explain this module')
    expect(screen.getByText('Review code')).toHaveAttribute('title', 'Review code')

    const scrollTrack = screen.getByTestId('featured-scenarios-scroll')
    Object.defineProperties(scrollTrack, {
      clientWidth: { configurable: true, value: 500 },
      scrollWidth: { configurable: true, value: 900 },
      scrollLeft: { configurable: true, value: 0, writable: true },
      scrollBy: { configurable: true, value: jest.fn() },
    })
    fireEvent.scroll(scrollTrack)
    const scrollRightButton = await screen.findByTestId('featured-scenarios-scroll-right')
    expect(scrollRightButton).toHaveClass(
      'top-1/2',
      'h-11',
      'w-11',
      'md:h-6',
      'md:w-6',
      'rounded-full',
      'shadow-md'
    )
    fireEvent.click(scrollRightButton)
    expect(scrollTrack.scrollBy).toHaveBeenCalledWith({
      left: 292,
      behavior: 'smooth',
    })

    fireEvent.click(screen.getByTestId('featured-agent-research-open'))
    expect(mockPush).toHaveBeenCalledWith('/chat?teamId=1&quickLauncher=system%3Aresearch')

    fireEvent.click(screen.getByTestId('featured-agent-coder-example-review'))
    expect(mockPush).toHaveBeenCalledWith(
      '/chat?teamId=2&quickLauncher=system%3Acoder&quickPreset=review&agent=code'
    )

    fireEvent.click(screen.getByTestId('featured-agent-image-example-draw'))
    expect(mockPush).toHaveBeenCalledWith(
      '/chat?teamId=3&quickLauncher=system%3Aimage&quickPreset=draw&mode=image'
    )

    fireEvent.click(screen.getByTestId('featured-agent-image-open'))
    expect(mockPush).toHaveBeenCalledWith(
      '/chat?teamId=3&quickLauncher=system%3Aimage&showPresets=1&mode=image'
    )

    fireEvent.click(screen.getByTestId('featured-agent-video-example-create'))
    expect(mockPush).toHaveBeenCalledWith(
      '/chat?teamId=4&quickLauncher=system%3Avideo&quickPreset=create&mode=video'
    )

    fireEvent.click(screen.getByTestId('featured-agent-video-open'))
    expect(mockPush).toHaveBeenCalledWith(
      '/chat?teamId=4&quickLauncher=system%3Avideo&showPresets=1&mode=video'
    )
  })
})
