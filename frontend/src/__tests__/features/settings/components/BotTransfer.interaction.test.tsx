// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Bot, PipelineContextPassing } from '@/types/api'
import BotTransfer from '@/features/settings/components/team-modes/BotTransfer'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common:team.bots': 'Bots',
        'common:team.candidates': 'Candidates',
        'common:team.in_team': 'Team members',
        'common:team.prompts_link': 'Team prompt add-ons',
        'common:team.prompts_tooltip': 'Add team-only guidance.',
        'common:team.prompts_tag_none': 'None',
        'common:team.prompts_badge': 'Team prompt',
        'common:team.prompts_badge_tooltip': 'This bot has a team prompt.',
        'common:team.pipeline_column_member': 'Member',
        'common:team.pipeline_column_next_input': 'Send to next member',
        'common:team.pipeline_column_review': 'Review',
        'common:team.pipeline_column_actions': 'Actions',
        'common:team.context_passing_label': 'Send to next member',
        'common:team.context_passing_last_step': 'Last step',
        'common:team.context_passing_none': 'No context',
        'common:team.context_passing_original_user': 'User request',
        'common:team.context_passing_previous_bot': 'This step output',
        'common:team.context_passing_original_and_previous': 'Request + this step output',
        'common:team.require_confirmation_checkbox_label': 'Pause',
        'common:team.require_confirmation_not_needed': 'None',
        'common:actions.edit': 'Edit',
        'common:actions.copy': 'Copy',
        'common:bots.new_bot': 'New bot',
      })[key] || key,
  }),
}))

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const makeBot = (id: number, name: string): Bot => ({
  id,
  name,
  namespace: 'default',
  shell_name: 'ClaudeCode',
  shell_type: 'ClaudeCode',
  agent_config: {},
  system_prompt: '',
  mcp_servers: {},
  is_active: true,
  created_at: '2026-06-16T00:00:00Z',
  updated_at: '2026-06-16T00:00:00Z',
})

function renderPipelineTransfer({
  requireConfirmationMap = { 1: false, 2: false },
  contextPassingMap = { 1: 'previous_bot' as PipelineContextPassing },
  setRequireConfirmationMap = jest.fn(),
  setContextPassingMap = jest.fn(),
} = {}) {
  render(
    <BotTransfer
      bots={[makeBot(1, 'spec'), makeBot(2, 'dev')]}
      selectedBotKeys={['1', '2']}
      setSelectedBotKeys={jest.fn()}
      unsavedPrompts={{}}
      teamPromptMap={new Map()}
      sortable
      requireConfirmationMap={requireConfirmationMap}
      setRequireConfirmationMap={setRequireConfirmationMap}
      contextPassingMap={contextPassingMap}
      setContextPassingMap={setContextPassingMap}
      onEditBot={jest.fn()}
      onCreateBot={jest.fn()}
      onCloneBot={jest.fn()}
      onOpenPromptDrawer={jest.fn()}
    />
  )

  return { setRequireConfirmationMap, setContextPassingMap }
}

describe('BotTransfer pipeline member interactions', () => {
  it('renders selected pipeline members as table rows with standard controls', () => {
    renderPipelineTransfer()

    const header = screen.getByTestId('pipeline-member-grid-header')
    expect(header).toHaveTextContent('Member')
    expect(header).toHaveTextContent('Send to next member')
    expect(header).toHaveTextContent('Review')
    expect(header).toHaveTextContent('Actions')

    const firstRow = screen.getByTestId('pipeline-member-row-1')
    expect(firstRow).toHaveTextContent('spec')
    expect(firstRow).toHaveTextContent('This step output')
    expect(screen.getByTestId('context-passing-select-1')).toHaveAccessibleName(
      /send to next member spec/i
    )
    expect(screen.getByTestId('require-confirmation-toggle-1')).toHaveAttribute('role', 'checkbox')
    expect(screen.getByTestId('require-confirmation-toggle-1')).toHaveAccessibleName(/pause/i)
    expect(firstRow).not.toHaveTextContent('Pause')
    expect(firstRow).not.toHaveTextContent('Auto continue')
  })

  it('marks the final pipeline member without next-member or review controls', () => {
    renderPipelineTransfer({ requireConfirmationMap: { 1: false, 2: true } })

    const finalRow = screen.getByTestId('pipeline-member-row-2')
    expect(finalRow).toHaveTextContent('dev')
    expect(finalRow).toHaveTextContent('Last step')
    expect(finalRow).toHaveTextContent('None')
    expect(screen.queryByTestId('context-passing-select-2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('require-confirmation-toggle-2')).not.toBeInTheDocument()
  })

  it('toggles confirmation through a standard checkbox', () => {
    const setRequireConfirmationMap = jest.fn()
    renderPipelineTransfer({ setRequireConfirmationMap })

    fireEvent.click(screen.getByTestId('require-confirmation-toggle-1'))

    expect(setRequireConfirmationMap).toHaveBeenCalledWith(expect.any(Function))
    const update = setRequireConfirmationMap.mock.calls[0][0]
    expect(update({ 1: false, 2: false })).toEqual({ 1: true, 2: false })
  })
})
