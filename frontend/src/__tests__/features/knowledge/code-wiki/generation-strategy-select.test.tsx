// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import { GenerationStrategySelect } from '@/features/knowledge/code-wiki/GenerationStrategySelect'
import { codeWikiApi } from '@/apis/code-wiki'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.strategy ? `${key}:${values.strategy}` : key,
  }),
}))

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { strategies: jest.fn() },
}))

describe('generation strategy selector', () => {
  it('renders only the deployment-provided default and does not need Team wiring', async () => {
    jest.mocked(codeWikiApi.strategies).mockResolvedValue({
      default_strategy: 'coordinator_adaptive',
      strategies: [
        {
          id: 'coordinator_adaptive',
          revision: 1,
          display_name: 'Adaptive coordinator',
          description: 'Writes or delegates by scope.',
        },
      ],
    })

    render(
      <GenerationStrategySelect
        value=""
        onChange={jest.fn()}
        emptyOption="deployment"
        testId="strategy-select"
      />
    )

    expect(
      await screen.findByText(
        'codeWiki.strategy.systemRecommended:codeWiki.strategy.options.coordinator_adaptive.title'
      )
    ).toBeInTheDocument()
    expect(codeWikiApi.strategies).toHaveBeenCalledTimes(1)
  })
})
