// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import {
  ModelCascadeContent,
  type ModelCascadeLabels,
} from '@/components/model-select/ModelCascadeSelect'
import { ModelSelectionGuideLink } from '@/components/model-select/ModelSelectionGuideLink'
import en from '@/i18n/locales/en/common.json'
import zh from '@/i18n/locales/zh-CN/common.json'

let mockGuideUrl = ''
let mockLanguage: 'en' | 'zh' = 'en'

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => ({ modelSelectionGuideUrl: mockGuideUrl }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'models.selection_guide'
        ? (mockLanguage === 'zh' ? zh : en).models.selection_guide
        : key,
  }),
}))

const labels: ModelCascadeLabels = {
  ungrouped: 'Ungrouped',
  uncategorized: 'Uncategorized',
  searchPlaceholder: 'Search models',
  searchResults: 'Search results',
  noModels: 'No models',
  noMatch: 'No match',
  primaryGroups: 'Primary groups',
  secondaryGroups: 'Secondary groups',
}

const model = {
  name: 'friendly-model',
  displayName: 'Friendly Model',
  modelId: 'private-upstream-model-id',
  capability: '擅长复杂推理与长程任务。Fast responses for everyday tasks. '.repeat(4),
}

describe('model selector presentation', () => {
  beforeEach(() => {
    mockGuideUrl = ''
    mockLanguage = 'en'
  })

  it.each(['desktop', 'mobile'] as const)(
    'shows capabilities instead of model IDs and keeps actions separate on %s',
    variant => {
      const onSelectModel = jest.fn()
      render(
        <ModelCascadeContent
          models={[model]}
          selectedModel={model}
          labels={labels}
          searchValue="friendly"
          onSearchValueChange={jest.fn()}
          onSelectModel={onSelectModel}
          renderModelActions={() => <button type="button">View details</button>}
          variant={variant}
        />
      )

      const option = screen.getByRole('button', { name: /Friendly Model/ })
      const description = screen.getByText(model.capability.trim())
      const details = screen.getByRole('button', { name: 'View details' })
      expect(option).toContainElement(description)
      expect(description).toHaveClass('whitespace-normal', 'break-words')
      expect(option).not.toContainElement(details)
      expect(option.parentElement).toContainElement(details)
      expect(screen.queryByText(model.modelId)).not.toBeInTheDocument()

      fireEvent.click(option)
      expect(onSelectModel).toHaveBeenCalledWith(model)
    }
  )

  it.each([undefined, null, '', '   '])('shows only the name when capability is %p', capability => {
    render(
      <ModelCascadeContent
        models={[{ ...model, capability }]}
        labels={labels}
        searchValue="friendly"
        onSearchValueChange={jest.fn()}
        onSelectModel={jest.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /Friendly Model/ })).toBeInTheDocument()
    expect(screen.queryByText(model.capability.trim())).not.toBeInTheDocument()
    expect(screen.queryByText(model.modelId)).not.toBeInTheDocument()
  })

  it('hides the guide link when no URL is configured', () => {
    render(<ModelSelectionGuideLink />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it.each(['en', 'zh'] as const)('opens the configured guide with %s text', language => {
    mockLanguage = language
    mockGuideUrl = 'https://example.com/model-guide'
    render(
      <ModelCascadeContent
        models={[model]}
        labels={labels}
        searchValue=""
        onSearchValueChange={jest.fn()}
        onSelectModel={jest.fn()}
      />
    )

    const link = screen.getByRole('link', {
      name: (language === 'zh' ? zh : en).models.selection_guide,
    })
    expect(link).toHaveAttribute('href', mockGuideUrl)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByTestId('model-cascade-footer')).toContainElement(link)
  })
})
