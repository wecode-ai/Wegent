// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HTMLAttributes, ReactNode } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { PublishResourceDialog } from '@/features/resource-library/components/PublishResourceDialog'

const mockToast = jest.fn()
const mockOnOpenChange = jest.fn()
const mockOnPublished = jest.fn()

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    createListing: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'actions.cancel': '取消',
        'actions.publish': '发布资源',
        'fields.description': '描述',
        'fields.display_name': '显示名称',
        'fields.name': '名称',
        'fields.source_id': '源资源 ID',
        'fields.tags': '标签',
        'fields.type': '资源类型',
        'fields.version': '版本',
        'filters.agent': '智能体',
        'filters.skill': '技能',
        'messages.publish_success': '发布成功',
        'publish.description': '将已有智能体或技能发布到资源库',
        'publish.selected_resource': '已选资源',
      }

      return translations[key] ?? key
    },
  }),
}))

const mockResourceLibraryApi = resourceLibraryApi as jest.Mocked<typeof resourceLibraryApi>

describe('PublishResourceDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResourceLibraryApi.createListing.mockResolvedValue({
      id: 1,
      resource_type: 'agent',
      name: 'personal-wiki',
      display_name: '个人 wiki',
      description: 'Personal wiki agent',
      icon: null,
      tags: ['wiki'],
      publisher_user_id: 1,
      status: 'published',
      install_count: 0,
      is_installed: false,
      created_at: '2026-05-28T00:00:00',
      updated_at: '2026-05-28T00:00:00',
    })
  })

  it('publishes the selected source resource without exposing source id input', async () => {
    render(
      <PublishResourceDialog
        open
        resourceType="all"
        sourceResource={{
          resourceType: 'agent',
          sourceId: 42,
          name: 'personal-wiki',
          displayName: '个人 wiki',
          description: 'Personal wiki agent',
          tags: ['wiki'],
        }}
        onOpenChange={mockOnOpenChange}
        onPublished={mockOnPublished}
      />
    )

    expect(screen.getByText('已选资源')).toBeInTheDocument()
    expect(screen.getByText('个人 wiki')).toBeInTheDocument()
    expect(screen.queryByTestId('publish-resource-source-id-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('publish-resource-name-input')).toHaveValue('personal-wiki')
    expect(screen.getByTestId('publish-resource-display-name-input')).toHaveValue('个人 wiki')
    expect(screen.getByTestId('publish-resource-description-textarea')).toHaveValue(
      'Personal wiki agent'
    )
    expect(screen.getByTestId('publish-resource-tags-input')).toHaveValue('wiki')

    fireEvent.click(screen.getByTestId('publish-resource-submit-button'))

    await waitFor(() => {
      expect(mockResourceLibraryApi.createListing).toHaveBeenCalledWith({
        resource_type: 'agent',
        source_id: 42,
        name: 'personal-wiki',
        display_name: '个人 wiki',
        description: 'Personal wiki agent',
        icon: null,
        tags: ['wiki'],
        version: '1.0.0',
        manifest_options: {},
      })
    })
    expect(mockToast).toHaveBeenCalledWith({ title: '发布成功' })
    expect(mockOnOpenChange).toHaveBeenCalledWith(false)
    expect(mockOnPublished).toHaveBeenCalled()
  })
})
