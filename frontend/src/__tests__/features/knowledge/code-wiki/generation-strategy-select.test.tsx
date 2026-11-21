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
  beforeEach(() => jest.mocked(codeWikiApi.strategies).mockReset())

  it.each([
    ['an empty strategy list', 'codeWiki.strategy.noneAvailable', false],
    ['a failed request', 'codeWiki.strategy.loadFailed', true],
  ])('explains why selection is disabled for %s', async (_scenario, message, failed) => {
    const strategies = jest.mocked(codeWikiApi.strategies)
    if (failed) strategies.mockRejectedValueOnce(new Error('Request failed'))
    else strategies.mockResolvedValueOnce({ default_strategy: null, strategies: [] })

    render(<GenerationStrategySelect value="" onChange={jest.fn()} testId="strategy-select" />)

    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.getByTestId('strategy-select')).toBeDisabled()
  })

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
