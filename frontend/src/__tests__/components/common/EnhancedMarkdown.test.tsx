// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { SANDBOXED_HTML_SEND_TO_CHAT_EVENT } from '@/components/common/SandboxedHtmlFrame'

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

  it('renders artifact HTML in a sandboxed iframe instead of the host markdown tree', () => {
    const onSendMessage = jest.fn()
    const { container } = render(
      <EnhancedMarkdown
        theme="light"
        onSendMessage={onSendMessage}
        source={`Before

<artifact title="午餐选择卡片">
<!DOCTYPE html>
<html lang="zh">
<head>
  <style>
    body { background: red; }
  </style>
</head>
<body>
  <button onclick="sendToChat('我选择火锅')">火锅</button>
</body>
</html>
</artifact>

After`}
      />
    )

    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('After')).toBeInTheDocument()
    expect(screen.getByText('午餐选择卡片')).toBeInTheDocument()
    expect(screen.queryByText(/background: red/)).not.toBeInTheDocument()

    const iframe = container.querySelector('iframe')
    expect(iframe).toBeInTheDocument()
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
    expect(iframe).toHaveAttribute('srcdoc', expect.stringContaining('body { background: red; }'))
    expect(iframe).toHaveAttribute('srcdoc', expect.stringContaining('window.sendToChat'))

    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe?.contentWindow,
        data: {
          type: SANDBOXED_HTML_SEND_TO_CHAT_EVENT,
          message: ' 我选择火锅 ',
        },
      })
    )

    expect(onSendMessage).toHaveBeenCalledWith('我选择火锅')
  })
})
