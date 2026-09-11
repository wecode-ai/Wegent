// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import {
  CollaborationApp,
  type CollaborationHostAdapter,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'

describe('CollaborationApp Web My Work boundary', () => {
  it('does not render or request My Work when the Web host disables it', async () => {
    const listMyWork = jest.fn().mockResolvedValue([])
    const api = {
      projects: { list: jest.fn().mockResolvedValue([]) },
      myWork: { list: listMyWork },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: {
        myWork: false,
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: null,
        issueId: null,
        view: 'board',
        rootView: 'my-work',
      },
      navigate: jest.fn(),
    }

    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

    expect(await screen.findByTestId('collaboration-project-create')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-my-work-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-projects-home-my-work')).not.toBeInTheDocument()
    expect(listMyWork).not.toHaveBeenCalled()
  })
})
