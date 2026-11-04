// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CollaborationTemplateMarketplace } from '@/features/resource-library/CollaborationTemplateMarketplace'
import { CollaborationTemplateStore, templateIdentity } from '@wegent/collaboration/templates'

const mockPush = jest.fn()
const mockList = jest.fn()
const mockGet = jest.fn()
const mockApi = {
  projects: { list: mockList, get: mockGet, listCollaborationGroups: jest.fn(async () => []) },
  members: { list: jest.fn(async () => []) },
  agents: { list: jest.fn(async () => []) },
}
let mockStore: CollaborationTemplateStore
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => '/resource-library',
}))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}))
jest.mock('@/features/resource-library/useCollaborationTemplates', () => ({
  useCollaborationTemplates: () => mockStore,
}))
jest.mock('@/features/collaboration/shared-api', () => ({
  createWebSharedWorkspaceApi: () => mockApi,
}))
jest.mock('@/features/collaboration/ProjectAgentConfigurationHost', () => ({
  webProjectAgentConfigurationHost: {},
}))

beforeEach(() => {
  jest.clearAllMocks()
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
  mockStore = new CollaborationTemplateStore({
    scope: 'account-7',
    ownerId: 7,
    persistence: { read: async () => [], write: async () => {} },
  })
  mockList.mockResolvedValue([
    {
      id: 'editable',
      name: 'My project',
      workspace_id: 'space',
      status: 'active',
      access_role: 'Maintainer',
    },
    {
      id: 'readonly',
      name: 'Read only',
      workspace_id: 'space',
      status: 'active',
      access_role: 'Viewer',
    },
  ])
  mockGet.mockResolvedValue({ id: 'editable', access_role: 'Maintainer' })
})

async function openDestination() {
  render(<CollaborationTemplateMarketplace />)
  expect(mockList).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('template-details-product-lifecycle'))
  fireEvent.click(screen.getByTestId('template-use'))
  await screen.findByTestId('template-create-project')
}

it('exposes use for built-in templates and carries the selected template into project creation', async () => {
  await openDestination()
  fireEvent.click(screen.getByTestId('template-create-project'))
  expect(mockPush).toHaveBeenCalledWith(
    `/collaboration?template=${encodeURIComponent(templateIdentity(mockStore.getSnapshot().records[0]))}`
  )
})

it('lists manageable projects lazily and loads only the selected project before role confirmation', async () => {
  await openDestination()
  await screen.findByTestId('template-project-editable')
  expect(screen.queryByTestId('template-project-readonly')).not.toBeInTheDocument()
  expect(mockGet).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('template-project-editable'))
  await screen.findByTestId('template-bindings-apply')
  expect(mockGet).toHaveBeenCalledWith('editable')
})

it('keeps new project creation available when the project list fails and supports retry', async () => {
  mockList.mockRejectedValueOnce(new Error('offline'))
  await openDestination()
  await screen.findByTestId('template-destination-retry')
  expect(screen.getByTestId('template-create-project')).toBeEnabled()
  fireEvent.click(screen.getByTestId('template-destination-retry'))
  await waitFor(() => expect(screen.getByTestId('template-project-editable')).toBeVisible())
})
