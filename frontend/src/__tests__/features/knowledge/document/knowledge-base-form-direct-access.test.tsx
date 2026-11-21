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
  function Form({
    onDirectAccessRequirementChange = jest.fn(),
    onCallLimitsChange = jest.fn(),
    editableSection,
  }: {
    onDirectAccessRequirementChange?: jest.Mock
    onCallLimitsChange?: jest.Mock
    editableSection?: 'generation'
  }) {
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
        onCallLimitsChange={onCallLimitsChange}
        editableSection={editableSection}
        generationSection={<p>Schedule settings</p>}
        navigation={navigation}
        showRetrievalSection={false}
        retrievalConfig={{}}
        onRetrievalConfigChange={jest.fn()}
      />
    )
  }

  it('reveals the access settings when its navigation button is selected', () => {
    const onDirectAccessRequirementChange = jest.fn()
    render(<Form onDirectAccessRequirementChange={onDirectAccessRequirementChange} />)
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

  it('does not change either call limit while only the schedule can be edited', () => {
    const onCallLimitsChange = jest.fn()
    render(<Form onCallLimitsChange={onCallLimitsChange} editableSection="generation" />)

    fireEvent.click(screen.getByTestId('knowledge-guided-questions-section-trigger'))
    const sliders = screen.getAllByRole('slider')
    expect(sliders).toHaveLength(2)
    for (const slider of sliders) {
      expect(slider).not.toHaveAttribute('tabindex', '0')
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
    }
    expect(onCallLimitsChange).not.toHaveBeenCalled()
  })
})
