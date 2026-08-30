import { describe, expect, test, vi } from 'vitest'
import {
  deleteLocalCodexModelCatalogOverride,
  getLocalCodexModelCatalogOverrides,
  saveLocalCodexModelCatalogOverride,
} from './codexOfficialModels'

describe('codexOfficialModels catalog overrides', () => {
  test('normalizes readable catalog override entries and ignores malformed values', async () => {
    const request = vi.fn().mockResolvedValue({
      models: [
        {
          slug: 'gpt-5.6-sol',
          baseline: { slug: 'gpt-5.6-sol', context_window: 272_000 },
          effective: { slug: 'gpt-5.6-sol', context_window: 300_000 },
          overridden: true,
        },
        { slug: '', baseline: {}, effective: {} },
      ],
    })

    await expect(getLocalCodexModelCatalogOverrides(['gpt-5.6-sol'], request)).resolves.toEqual([
      {
        slug: 'gpt-5.6-sol',
        baseline: { slug: 'gpt-5.6-sol', context_window: 272_000 },
        effective: { slug: 'gpt-5.6-sol', context_window: 300_000 },
        overridden: true,
      },
    ])
    expect(request).toHaveBeenCalledWith('runtime.codex.catalog.overrides.read', {
      slugs: ['gpt-5.6-sol'],
    })
  })

  test('writes and deletes one model override through dedicated runtime methods', async () => {
    const request = vi.fn().mockResolvedValue({})
    const entry = { slug: 'gpt-5.6-sol', context_window: 300_000 }

    await saveLocalCodexModelCatalogOverride('gpt-5.6-sol', entry, request)
    await deleteLocalCodexModelCatalogOverride('gpt-5.6-sol', request)

    expect(request).toHaveBeenNthCalledWith(1, 'runtime.codex.catalog.overrides.write', {
      slug: 'gpt-5.6-sol',
      entry,
    })
    expect(request).toHaveBeenNthCalledWith(2, 'runtime.codex.catalog.overrides.delete', {
      slug: 'gpt-5.6-sol',
    })
  })
})
