// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  KnowledgeBaseForm,
  useKnowledgeBaseFormNavigation,
} from '@/features/knowledge/document/components/KnowledgeBaseForm'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalFeatureEnabled', () => ({
  useMultimodalFeatureEnabled: () => false,
}))

describe('KnowledgeBaseForm direct access section', () => {
  it('reveals the access settings when its navigation button is selected', () => {
    const onDirectAccessRequirementChange = jest.fn()

    function Form() {
      const navigation = useKnowledgeBaseFormNavigation()
      return (
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
          navigation={navigation}
          showRetrievalSection={false}
          retrievalConfig={{}}
          onRetrievalConfigChange={jest.fn()}
        />
      )
    }

    render(<Form />)
    const basicSection = screen.getByTestId('knowledge-basic-section-trigger')
    const accessSection = screen.getByTestId('knowledge-access-section-trigger')
    expect(basicSection).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByRole('radio')).toBeNull()

    fireEvent.click(accessSection)
    expect(accessSection).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('knowledge-base-direct-access-edit')).toBeChecked()
    fireEvent.click(screen.getByTestId('knowledge-base-direct-access-read'))
    expect(onDirectAccessRequirementChange).toHaveBeenCalledWith('read')
  })
})
