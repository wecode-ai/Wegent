// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'

jest.mock('next/dynamic', () => () => {
  const DynamicComponent = () => null
  DynamicComponent.displayName = 'MockDynamicComponent'
  return DynamicComponent
})

describe('EnhancedMarkdown', () => {
  it('renders markdown wrapped by horizontal-rule separators as normal content', () => {
    render(
      <EnhancedMarkdown
        theme="light"
        source={`---
🚨 **定位不准告警 | AI排查建议**

**异常概览**：短时间内收到10条定位不准反馈，设备集中为华为/荣耀机型。

---`}
      />
    )

    expect(screen.getByText('🚨 **定位不准告警 | AI排查建议**')).toBeInTheDocument()
    expect(
      screen.getByText('**异常概览**：短时间内收到10条定位不准反馈，设备集中为华为/荣耀机型。')
    ).toBeInTheDocument()
    expect(screen.queryByText('Metadata')).not.toBeInTheDocument()
  })

  it('renders real YAML frontmatter as metadata and keeps the body', () => {
    render(
      <EnhancedMarkdown
        theme="light"
        source={`---
sidebar_position: 1
title: Test
---
# Body`}
      />
    )

    expect(screen.getByText('Metadata')).toBeInTheDocument()
    expect(screen.getByText('sidebar_position')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('# Body')).toBeInTheDocument()
  })
})
