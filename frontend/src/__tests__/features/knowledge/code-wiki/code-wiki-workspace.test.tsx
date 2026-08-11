// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import { CodeWikiWorkspace } from '@/features/knowledge/code-wiki/CodeWikiWorkspace'
import type { KnowledgeBase } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: 7 } }),
}))

jest.mock('@/features/knowledge/document/hooks/useNamespaceRoleMap', () => ({
  useNamespaceRoleMap: () => new Map(),
}))

jest.mock('@/features/knowledge/permission/hooks/useKnowledgePermissions', () => ({
  useKnowledgePermissions: () => ({
    myPermission: { role: 'owner' },
    fetchMyPermission: jest.fn(),
  }),
}))

jest.mock('@/utils/namespace-permissions', () => ({
  canManageKnowledgeBase: () => true,
  canManageKnowledgeBaseDocuments: () => true,
  canManageKnowledgeBasePermissions: () => true,
}))

jest.mock('@/features/knowledge/code-wiki/CodeWikiReader', () => ({
  CodeWikiReader: () => <div data-testid="mock-code-wiki-reader" />,
}))

jest.mock('@/features/knowledge/document/components/DocumentList', () => ({
  DocumentList: ({
    contentOrigin,
    readOnly,
    canUpload,
  }: {
    contentOrigin?: string
    readOnly?: boolean
    canUpload?: boolean
  }) => (
    <div
      data-testid="mock-code-wiki-document-list"
      data-origin={contentOrigin}
      data-read-only={String(readOnly)}
      data-can-upload={String(canUpload)}
    />
  ),
}))

jest.mock('@/features/knowledge/permission/components/PermissionManagementTab', () => ({
  PermissionManagementTab: () => <div data-testid="mock-code-wiki-permissions" />,
}))

const wiki: KnowledgeBase = {
  id: 42,
  name: 'workspace-wiki',
  description: null,
  user_id: 7,
  namespace: 'default',
  document_count: 0,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 5,
  exempt_calls_before_check: 0,
  kb_type: 'code_wiki',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
}

describe('CodeWikiWorkspace', () => {
  it('keeps Wiki as the default and presents user and generated content as virtual roots', () => {
    render(<CodeWikiWorkspace wiki={wiki} />)

    expect(screen.getByTestId('mock-code-wiki-reader')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByTestId('code-wiki-view-documents'))

    expect(screen.getByTestId('code-wiki-content-roots')).toBeInTheDocument()
    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-origin',
      'user'
    )
    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-read-only',
      'false'
    )
    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-can-upload',
      'true'
    )

    fireEvent.mouseDown(screen.getByTestId('code-wiki-content-generated'))

    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-origin',
      'generated'
    )
    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-read-only',
      'true'
    )

    fireEvent.mouseDown(screen.getByTestId('code-wiki-content-permissions'))

    expect(screen.getByTestId('mock-code-wiki-permissions')).toBeInTheDocument()
  })
})
