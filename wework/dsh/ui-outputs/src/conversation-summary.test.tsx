import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import {
  WEWORK_HOST_SERVICES,
  type ConversationOutputsSnapshot,
} from '@/features/dsh-runtime/conversationHostServices'
import type { ConversationSummarySurfaceProps } from '@/features/dsh-runtime/conversationSummarySurface'
import OutputsConversationSummary from './conversation-summary'

function surfaceProps(
  overrides: Partial<ConversationOutputsSnapshot> = {}
): ConversationSummarySurfaceProps {
  const outputs = {
    outputs: [],
    sources: [],
    ...overrides,
  }
  return {
    context: { 'workspace.isGitRepository': false },
    docked: true,
    onClose: vi.fn(),
    services: {
      canExecuteCommand: vi.fn(() => false),
      executeCommand: vi.fn(),
      getService: id => {
        if (id === WEWORK_HOST_SERVICES.conversationOutputs) {
          return { read: () => outputs }
        }
        return undefined
      },
      openResource: vi.fn(),
    },
  }
}

describe('OutputsConversationSummary', () => {
  test('renders the empty output state without a create menu', () => {
    render(<OutputsConversationSummary {...surfaceProps()} />)

    expect(screen.getByText('输出内容')).toBeInTheDocument()
    expect(screen.getByTestId('conversation-output-empty')).toHaveTextContent('暂无输出内容')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('创建文档')).not.toBeInTheDocument()
  })

  test('renders host-provided outputs and sources and opens their resources', async () => {
    const props = surfaceProps({
      outputs: [
        {
          id: 'file:report',
          kind: 'file',
          resource: { kind: 'file', path: '/workspace/report.md' },
          title: 'report.md',
        },
      ],
      sources: [
        {
          id: 'website:example',
          kind: 'website',
          resource: { kind: 'url', url: 'https://example.com' },
          title: 'example.com',
        },
      ],
    })
    render(<OutputsConversationSummary {...props} />)

    await userEvent.click(screen.getByText('report.md'))
    await userEvent.click(screen.getByText('example.com'))

    expect(props.services.openResource).toHaveBeenNthCalledWith(1, {
      kind: 'file',
      path: '/workspace/report.md',
    })
    expect(props.services.openResource).toHaveBeenNthCalledWith(2, {
      kind: 'url',
      url: 'https://example.com',
    })
  })
})
