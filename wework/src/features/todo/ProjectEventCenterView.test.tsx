import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectEventCenterView } from './ProjectEventCenterView'
import type { BoardIncomingEvent } from '@/api/projectEventCenter'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const event: BoardIncomingEvent = {
  id: 'event-1',
  title: '处理账单',
  content: '处理这批账单',
  status: 'clarifying',
  provider: 'manual',
  issue_id: null,
  version: 2,
  history: [{ role: 'router', content: '希望得到什么结果？', at: 'now' }],
  question: '希望得到什么结果？',
  error: null,
  automation_id: null,
  execution_id: 1,
  reference: null,
  created_at: 'now',
}

function fixture() {
  const api = {
    config: vi.fn().mockResolvedValue({
      enabled: true,
      runtime_profile_id: 'runtime',
      workspace_binding: { type: 'standalone' },
      instruction: '',
      version: 1,
    }),
    configure: vi.fn(),
    list: vi.fn().mockResolvedValue([event]),
    submit: vi.fn().mockResolvedValue(event),
    reply: vi.fn().mockResolvedValue(event),
    retry: vi.fn().mockResolvedValue(event),
  }
  const runtimeProfileApi = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getProjectDefault: vi.fn(),
    setProjectDefault: vi.fn(),
    selectExecution: vi.fn(),
  }
  return {
    api,
    runtimeProfileApi,
    projectId: 'board-1',
    canManage: true,
    canSubmit: true,
    onOpenIssue: vi.fn(),
    onOpenHooks: vi.fn(),
  }
}

describe('ProjectEventCenterView', () => {
  it('shows clarification and sends the answer with its event version', async () => {
    const props = fixture()
    render(<ProjectEventCenterView {...props} />)
    await screen.findByTestId('event-center-reply-content')
    fireEvent.change(screen.getByTestId('event-center-reply-content'), {
      target: { value: '列出差异清单' },
    })
    fireEvent.click(screen.getByTestId('event-center-reply'))
    await waitFor(() =>
      expect(props.api.reply).toHaveBeenCalledWith('board-1', event, '列出差异清单')
    )
    expect(props.api.submit).not.toHaveBeenCalled()
  })

  it('preserves the answer after failure', async () => {
    const props = fixture()
    props.api.reply.mockRejectedValue(new Error('Network unavailable'))
    render(<ProjectEventCenterView {...props} />)
    await screen.findByTestId('event-center-reply-content')
    fireEvent.change(screen.getByTestId('event-center-reply-content'), {
      target: { value: '保留答案' },
    })
    fireEvent.click(screen.getByTestId('event-center-reply'))
    await screen.findByText('Network unavailable')
    expect(screen.getByTestId('event-center-reply-content')).toHaveValue('保留答案')
  })

  it('opens the existing routed Issue and hides writes for readers', async () => {
    const props = fixture()
    props.api.list.mockResolvedValue([{ ...event, status: 'routed', issue_id: 'ISSUE-8' }])
    render(<ProjectEventCenterView {...props} canManage={false} canSubmit={false} />)
    fireEvent.click(await screen.findByTestId('event-center-open-issue'))
    await waitFor(() => expect(props.onOpenIssue).toHaveBeenCalledWith('ISSUE-8'))
    expect(screen.queryByTestId('event-center-submit')).not.toBeInTheDocument()
    expect(screen.queryByTestId('event-center-settings')).not.toBeInTheDocument()
    expect(props.runtimeProfileApi.list).not.toHaveBeenCalled()
  })
})
