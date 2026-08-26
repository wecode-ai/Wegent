// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { StoryboardVersionSelector } from '@wecode/features/video/storyboard/StoryboardVersionSelector'
import type { StoryboardVideoVersion } from '@wecode/features/video/storyboard/types'

jest.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (value: string) => void
  }) => (
    <div data-testid="mock-select" data-value={value}>
      {children}
      <button onClick={() => onValueChange?.('9001')}>select-v1</button>
    </div>
  ),
  SelectTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  SelectValue: ({
    children,
    placeholder,
  }: {
    children?: React.ReactNode
    placeholder?: string
  }) => <span data-testid="mock-select-value">{children ?? placeholder}</span>,
  SelectContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="mock-select-content" data-classname={className}>
      {children}
    </div>
  ),
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-testid={`option-${value}`}>{children}</div>
  ),
}))

jest.mock('lucide-react', () => ({
  Check: () => <span data-testid="check-icon" />,
}))

describe('StoryboardVersionSelector', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-05-15T15:30:00'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const versions: StoryboardVideoVersion[] = [
    {
      id: 9001,
      version_no: 1,
      generation_status: 3,
      progress: 100,
      model_video_url: 'https://old.mp4',
      video_cover_url: '',
      media_id: 'm1',
      duration: 5,
      error_message: null,
      task_uuid: null,
      shots_prompt: 'V1 prompt',
      create_time: '2026-05-13T09:10:00',
      is_selected: false,
    },
    {
      id: 9002,
      version_no: 2,
      generation_status: 3,
      progress: 100,
      model_video_url: 'https://new.mp4',
      video_cover_url: '',
      media_id: 'm2',
      duration: 5,
      error_message: null,
      task_uuid: null,
      shots_prompt: 'V2 prompt',
      create_time: '2026-05-13T10:10:00',
      is_selected: true,
    },
  ]

  it('renders selected version metadata and emits numeric clip ids on change', () => {
    const handleChange = jest.fn()

    render(
      <StoryboardVersionSelector
        currentVersion={versions[1]}
        versions={versions}
        onChange={handleChange}
      />
    )

    expect(screen.getByRole('button', { name: '分镜视频版本' })).toBeInTheDocument()
    expect(screen.getByTestId('mock-select')).toHaveAttribute('data-value', '9002')
    expect(screen.getByTestId('mock-select-content')).toHaveAttribute(
      'data-classname',
      expect.stringContaining('z-[2147483641]')
    )
    expect(screen.getByRole('button', { name: '分镜视频版本' })).toHaveTextContent('历史V2')
    expect(screen.getByRole('button', { name: '分镜视频版本' })).toHaveTextContent('5-13 10:10')

    const optionTexts = screen
      .getAllByTestId(/option-/)
      .map(node => node.textContent?.replace(/\s+/g, ' ').trim())
    expect(optionTexts).toEqual(['历史V25-13 10:10', '历史V15-13 09:10'])

    fireEvent.click(screen.getByRole('button', { name: 'select-v1' }))

    expect(handleChange).toHaveBeenCalledWith(9001)
  })

  it('falls back to alternate timestamp fields when create_time is missing', () => {
    render(
      <StoryboardVersionSelector
        currentVersion={{
          ...versions[1],
          create_time: '' as never,
          created_at: '2026-05-13T10:10:00',
        }}
        versions={
          [
            {
              ...versions[1],
              create_time: '' as never,
              created_at: '2026-05-13T10:10:00',
            },
            versions[0],
          ] as unknown as StoryboardVideoVersion[]
        }
        onChange={jest.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '分镜视频版本' })).toHaveTextContent('5-13 10:10')
  })

  it('formats timestamps by recency rules', () => {
    const recentVersions: StoryboardVideoVersion[] = [
      {
        ...versions[0],
        id: 9101,
        version_no: 1,
        create_time: '2026-05-15T15:05:00',
      },
      {
        ...versions[0],
        id: 9102,
        version_no: 2,
        create_time: '2026-05-15T14:10:00',
      },
      {
        ...versions[0],
        id: 9103,
        version_no: 3,
        create_time: '2026-05-14T09:05:00',
      },
      {
        ...versions[0],
        id: 9104,
        version_no: 4,
        create_time: '2026-05-13T10:10:00',
      },
      {
        ...versions[0],
        id: 9105,
        version_no: 5,
        create_time: '2025-12-31T08:00:00',
      },
    ]

    render(
      <StoryboardVersionSelector
        currentVersion={recentVersions[0]}
        versions={recentVersions}
        onChange={jest.fn()}
      />
    )

    const optionTexts = screen
      .getAllByTestId(/option-/)
      .map(node => node.textContent?.replace(/\s+/g, ' ').trim())

    expect(screen.getByRole('button', { name: '分镜视频版本' })).toHaveTextContent('25分钟前')
    expect(optionTexts).toEqual([
      '历史V525-12-31',
      '历史V45-13 10:10',
      '历史V3昨天 09:05',
      '历史V21小时前',
      '历史V125分钟前',
    ])
  })
})
