// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { apiClient } from '@/apis/client'
import { botApis } from '@/apis/bots'
import { modelApis } from '@/apis/models'
import { fetchUnifiedSkillsList } from '@/apis/skills'
import { teamApis } from '@/apis/team'
import { WebAgentResourceForm } from '@/features/collaboration/WebAgentResourceForm'

const mockTranslate = (_key: string, fallback?: string) => fallback || _key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

jest.mock('@/apis/client', () => ({
  apiClient: {
    get: jest.fn(),
  },
}))

jest.mock('@/apis/bots', () => ({
  botApis: {
    createBot: jest.fn(),
  },
}))

jest.mock('@/apis/models', () => ({
  modelApis: {
    getUnifiedModels: jest.fn(),
  },
}))

jest.mock('@/apis/skills', () => ({
  fetchUnifiedSkillsList: jest.fn(),
}))

jest.mock('@/apis/team', () => ({
  teamApis: {
    createTeam: jest.fn(),
  },
}))

describe('WebAgentResourceForm', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(modelApis.getUnifiedModels).mockResolvedValue({
      data: [
        {
          name: 'gpt-5',
          type: 'public',
          namespace: 'default',
          displayName: 'GPT-5',
        },
      ],
    })
    jest.mocked(fetchUnifiedSkillsList).mockResolvedValue([
      {
        id: 7,
        name: 'review',
        namespace: 'default',
        description: 'Review code',
        displayName: 'Code review',
        is_active: true,
        is_public: false,
        user_id: 1,
      },
    ])
    jest.mocked(apiClient.get).mockResolvedValue({
      items: [
        {
          apiVersion: 'wegent.io/v1',
          kind: 'InstalledPlugin',
          metadata: { name: 'company-mail' },
          spec: {
            source: {
              type: 'marketplace',
              providerKey: 'wegent',
              pluginKey: 'company-mail',
              marketplace: 'official',
            },
            displayName: 'Company Mail',
            description: '',
            installState: 'installed',
            enabled: true,
            manifest: {},
            components: {},
          },
          status: { state: 'Available' },
        },
      ],
    })
    jest.mocked(botApis.createBot).mockResolvedValue({ id: 31 } as never)
    jest.mocked(teamApis.createTeam).mockResolvedValue({
      id: 41,
      name: 'code-review-agent',
      displayName: '代码评审',
    } as never)
  })

  it('uses the shared form and submits display name, skills, and plugins', async () => {
    const onCreated = jest.fn().mockResolvedValue(undefined)

    render(
      <WebAgentResourceForm
        namespace="default"
        onClose={jest.fn()}
        onCreated={onCreated}
        workspaceName="我的空间"
      />
    )

    expect(screen.getByTestId('web-agent-resource-creator')).toHaveAttribute(
      'data-agent-form',
      'shared'
    )
    expect(screen.getByTestId('web-agent-resource-creator')).toHaveClass('max-w-[700px]')
    expect(screen.queryByTestId('web-agent-skills-add')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('web-agent-capability-mode-manual'))
    expect(screen.getByTestId('web-agent-skills-add')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByTestId('web-agent-model')).not.toBeDisabled())
    fireEvent.change(screen.getByTestId('web-agent-resource-name'), {
      target: { value: 'code-review-agent' },
    })
    fireEvent.change(screen.getByTestId('web-agent-display-name'), {
      target: { value: '代码评审' },
    })
    fireEvent.change(screen.getByTestId('web-agent-model'), {
      target: { value: 'public:default:gpt-5' },
    })
    await waitFor(() => expect(screen.getByTestId('web-agent-resource-create')).toBeEnabled())
    fireEvent.click(screen.getByTestId('web-agent-skills-add'))
    fireEvent.click(await screen.findByTestId('web-agent-skill-7'))
    fireEvent.click(screen.getByTestId('web-agent-plugins-add'))
    fireEvent.click(await screen.findByTestId('web-agent-plugin-company-mail@official'))
    fireEvent.click(screen.getByTestId('web-agent-resource-create'))

    await waitFor(() =>
      expect(botApis.createBot).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'code-review-agent-bot',
          capability_mode: 'manual',
          plugins: [
            {
              id: 'company-mail@official',
              pluginName: 'company-mail',
              marketplaceId: 'official',
              displayName: 'Company Mail',
            },
          ],
          skills: ['review'],
        })
      )
    )
    expect(teamApis.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'code-review-agent',
        displayName: '代码评审',
        namespace: 'default',
      })
    )
    expect(onCreated).toHaveBeenCalledWith({
      name: '代码评审',
      teamId: 41,
    })
  })
})
