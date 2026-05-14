// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Team } from '@/types/api'
import {
  buildTeamApiCurl,
  buildTeamApiModel,
  TeamApiCallButton,
} from '@/features/settings/components/TeamApiCallButton'

const mockPush = jest.fn()
const mockToast = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'teams.api_call.action': 'API Call',
        'teams.api_call.title': `API Call: ${options?.name ?? ''}`,
        'teams.api_call.description': 'Call this agent from external apps using the Responses API.',
        'teams.api_call.endpoint': 'Endpoint',
        'teams.api_call.model': 'Model',
        'teams.api_call.curl_example': 'curl example',
        'teams.api_call.copy_curl': 'Copy curl',
        'teams.api_call.manage_api_keys': 'Manage API Keys',
        'teams.api_call.view_docs': 'View docs',
        'teams.api_call.copy_success': 'curl copied',
        'teams.api_call.copy_failed': 'Failed to copy curl',
      }

      return translations[key] ?? key
    },
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/lib/runtime-config', () => ({
  getPublicApiBaseUrl: jest.fn(() => 'http://1.1.1.1:8000/api'),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const makeTeam = (overrides: Partial<Team> = {}): Team => ({
  id: 17,
  name: 'support-agent',
  displayName: 'Support Agent',
  namespace: 'default',
  description: 'Handles support questions',
  bots: [],
  workflow: { mode: 'solo' },
  is_active: true,
  user_id: 1,
  created_at: '2026-05-13T00:00:00Z',
  updated_at: '2026-05-13T00:00:00Z',
  bind_mode: ['chat'],
  ...overrides,
})

describe('TeamApiCallButton', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    })
    window.open = jest.fn()
  })

  it('builds the model identifier from namespace and team name', () => {
    expect(buildTeamApiModel(makeTeam())).toBe('default#support-agent')
    expect(buildTeamApiModel(makeTeam({ namespace: 'dev-group', name: 'code-agent' }))).toBe(
      'dev-group#code-agent'
    )
  })

  it('builds a curl command for the Responses API', () => {
    const curl = buildTeamApiCurl(
      makeTeam({ namespace: 'dev-group', name: 'code-agent' }),
      '帮我总结今天的待办',
      // The dialog should pass the resolved deployment endpoint into the curl builder.
      'https://wegent.example.com/api/v1/responses'
    )

    expect(curl).toContain('https://wegent.example.com/api/v1/responses')
    expect(curl).toContain('X-API-Key: <your-api-key>')
    expect(curl).toContain('"model": "dev-group#code-agent"')
    expect(curl).toContain('"tools": [{"type": "wegent_chat_bot"}]')
  })

  it('opens the dialog from the API call button', () => {
    render(<TeamApiCallButton team={makeTeam()} />)

    fireEvent.click(screen.getByRole('button', { name: 'API Call' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('API Call: Support Agent')).toBeInTheDocument()
    expect(screen.getByText('default#support-agent')).toBeInTheDocument()
  })

  it('uses a distinct connection icon for the API call action', () => {
    render(<TeamApiCallButton team={makeTeam()} />)

    const apiCallButton = screen.getByTestId('team-api-call-button-17')

    expect(apiCallButton.querySelector('.lucide-plug')).toBeInTheDocument()
    expect(apiCallButton.querySelector('.lucide-code-xml')).not.toBeInTheDocument()
  })

  it('copies the generated curl command', async () => {
    render(<TeamApiCallButton team={makeTeam({ namespace: 'group-a' })} />)

    fireEvent.click(screen.getByRole('button', { name: 'API Call' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy curl' }))

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('http://1.1.1.1:8000/api/v1/responses')
      )
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('"model": "group-a#support-agent"')
    )
    expect(mockToast).toHaveBeenCalledWith({ title: 'curl copied' })
  })

  it('routes to API Key settings from the dialog', () => {
    render(<TeamApiCallButton team={makeTeam()} />)

    fireEvent.click(screen.getByRole('button', { name: 'API Call' }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage API Keys' }))

    expect(mockPush).toHaveBeenCalledWith('/settings?section=api-keys&tab=api-keys')
  })
})
