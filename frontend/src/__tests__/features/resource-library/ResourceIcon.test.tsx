// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { ResourceIcon } from '@/features/resource-library/components/ResourceIcon'

describe('ResourceIcon', () => {
  it('renders a persisted marketplace image for an Agent', () => {
    render(
      <ResourceIcon
        resourceType="agent"
        name="Data Agent"
        icon="/marketplace-assets/agent-1.webp"
        marketplaceTags={['data_analysis']}
      />
    )

    const icon = screen.getByTestId('resource-icon')
    expect(icon).toHaveAttribute('data-icon-source', 'image')
    expect(icon).toHaveClass('rounded-full')
    expect(screen.getByTestId('resource-icon-image')).toHaveAttribute(
      'src',
      '/marketplace-assets/agent-1.webp'
    )
  })

  it('prefers a valid resource preset icon', () => {
    render(
      <ResourceIcon
        resourceType="skill"
        name="Design Skill"
        icon="palette"
        marketplaceTags={['technical_development']}
      />
    )

    expect(screen.getByTestId('resource-icon')).toHaveAttribute('data-icon-source', 'resource')
    expect(screen.getByTestId('resource-icon')).toHaveAttribute('data-icon-id', 'palette')
  })

  it('uses the first Chinese character when the resource has no icon', () => {
    render(
      <ResourceIcon
        resourceType="skill"
        name="技术开发助手"
        marketplaceTags={['custom_category', 'technical_development']}
      />
    )

    expect(screen.getByTestId('resource-icon')).toHaveAttribute('data-icon-source', 'initial')
    expect(screen.getByTestId('resource-icon')).toHaveAttribute('data-icon-id', '技')
    expect(screen.getByTestId('resource-icon')).toHaveTextContent('技')
  })

  it('uppercases the first English letter and assigns a stable background color', () => {
    const { rerender } = render(
      <ResourceIcon resourceType="agent" name="excel analyze" marketplaceTags={['data_analysis']} />
    )

    const firstClassName = screen.getByTestId('resource-icon').className
    const firstStyle = screen.getByTestId('resource-icon').getAttribute('style')
    expect(screen.getByTestId('resource-icon')).toHaveTextContent('E')
    expect(screen.getByTestId('resource-icon')).toHaveClass('border-transparent')
    expect(screen.getByTestId('resource-icon').style.backgroundColor).not.toBe('')
    expect(screen.getByTestId('resource-icon').style.color).not.toBe('')

    rerender(
      <ResourceIcon resourceType="agent" name="excel analyze" marketplaceTags={['data_analysis']} />
    )

    expect(screen.getByTestId('resource-icon').className).toBe(firstClassName)
    expect(screen.getByTestId('resource-icon').getAttribute('style')).toBe(firstStyle)
  })

  it('falls back to the resource type when the name has no usable character', () => {
    render(<ResourceIcon resourceType="skill" name="---" marketplaceTags={['custom_category']} />)

    expect(screen.getByTestId('resource-icon')).toHaveAttribute('data-icon-source', 'resource-type')
    expect(screen.getByTestId('resource-icon')).toHaveAttribute('data-icon-id', 'sparkles')
    expect(screen.getByTestId('resource-icon')).toHaveClass('rounded-xl')
  })
})
