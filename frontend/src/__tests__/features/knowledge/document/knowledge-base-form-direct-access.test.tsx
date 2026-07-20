// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { KnowledgeBaseForm } from '@/features/knowledge/document/components/KnowledgeBaseForm'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalFeatureEnabled', () => ({
  useMultimodalFeatureEnabled: () => false,
}))

describe('KnowledgeBaseForm direct access section', () => {
  it('places direct access after basic settings and exposes positive choices', () => {
    const onDirectAccessRequirementChange = jest.fn()

    render(
      <KnowledgeBaseForm
        name="Docs"
        description=""
        onNameChange={jest.fn()}
        onDescriptionChange={jest.fn()}
        directAccessRequirement="edit"
        onDirectAccessRequirementChange={onDirectAccessRequirementChange}
        summaryEnabled={false}
        onSummaryEnabledChange={jest.fn()}
        summaryModelRef={null}
        onSummaryModelChange={jest.fn()}
        multimodalAnalysisEnabled={false}
        onMultimodalAnalysisEnabledChange={jest.fn()}
        multimodalAnalysisModelRef={null}
        onMultimodalAnalysisModelChange={jest.fn()}
        callLimits={{ maxCalls: 10, exemptCalls: 5 }}
        onCallLimitsChange={jest.fn()}
        advancedOpen={false}
        onAdvancedOpenChange={jest.fn()}
        showRetrievalSection={false}
        retrievalConfig={{}}
        onRetrievalConfigChange={jest.fn()}
      />
    )

    const basicSection = screen.getByTestId('knowledge-basic-section-trigger')
    const accessSection = screen.getByTestId('knowledge-access-section-trigger')
    const summarySection = screen.getByTestId('knowledge-summary-section-trigger')

    expect(
      basicSection.compareDocumentPosition(accessSection) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      accessSection.compareDocumentPosition(summarySection) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    expect(screen.getByTestId('knowledge-base-direct-access-edit')).toBeChecked()
    fireEvent.click(screen.getByTestId('knowledge-base-direct-access-read'))
    expect(onDirectAccessRequirementChange).toHaveBeenCalledWith('read')
  })
})
