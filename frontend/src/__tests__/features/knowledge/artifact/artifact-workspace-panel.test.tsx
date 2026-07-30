// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ArtifactWorkspacePanel } from '@/features/knowledge/artifact/components/ArtifactWorkspacePanel'

let isDesktopCollapsed = false
const mockWorkspaceSidePanel = jest.fn()
const mockArtifactPanel = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/knowledge/document/components/WorkspaceSidePanel', () => ({
  WorkspaceSidePanel: (props: {
    children: ReactNode | ((state: { isDesktopCollapsed: boolean }) => ReactNode)
  }) => {
    mockWorkspaceSidePanel(props)
    return (
      <>
        {typeof props.children === 'function'
          ? props.children({ isDesktopCollapsed })
          : props.children}
      </>
    )
  },
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactPanel', () => ({
  ArtifactPanel: (props: Record<string, unknown>) => {
    mockArtifactPanel(props)
    return <div data-testid="artifact-panel" />
  },
}))

const defaultProps = {
  knowledgeBaseId: 12,
  selectedDocumentIds: [] as number[],
  refreshToken: 0,
  mobileVisible: false,
  onAdjustSources: jest.fn(),
  onAvailableDocumentCountChange: jest.fn(),
  onCreatePptDraft: jest.fn(),
}

describe('ArtifactWorkspacePanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    isDesktopCollapsed = false
  })

  it('uses a 72px desktop rail and switches the existing artifact panel layout', () => {
    const { rerender } = render(<ArtifactWorkspacePanel {...defaultProps} />)

    expect(mockWorkspaceSidePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        side: 'right',
        collapsedWidth: 72,
      })
    )
    expect(mockArtifactPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        layout: 'full',
      })
    )

    isDesktopCollapsed = true
    rerender(<ArtifactWorkspacePanel {...defaultProps} />)

    expect(mockArtifactPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        layout: 'rail',
      })
    )
  })
})
