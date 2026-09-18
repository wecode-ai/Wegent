import { createWebComposerQuickPhrases } from '@/features/collaboration/composerQuickPhrases'
import { defaultQuickPhrases } from '@wegent/chat-core/composer-quick-phrases'

describe('Web composer preference adapter', () => {
  it('loads PC defaults only when the account has no composer preference', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ preferences: {} })
      .mockResolvedValueOnce({ preferences: { composer_quick_phrases: [] } })
    const store = createWebComposerQuickPhrases({ get, put: jest.fn() })
    await store.load()
    expect(store.getSnapshot().phrases).toEqual(defaultQuickPhrases)
    await store.load()
    expect(store.getSnapshot().phrases).toEqual([])
    expect(get).toHaveBeenCalledWith('/users/me')
  })
  it('patches only the composer preference and decodes nullable server fields', async () => {
    const phrase = defaultQuickPhrases[0]
    const get = jest.fn().mockResolvedValue({ preferences: {} })
    const put = jest.fn().mockResolvedValue({
      preferences: {
        composer_quick_phrases: [{ ...phrase, attachmentPaths: null, createdAt: null }],
      },
    })
    const store = createWebComposerQuickPhrases({ get, put })
    await store.load()
    await store.save([phrase])
    expect(put).toHaveBeenCalledWith('/users/me', {
      preferences: { composer_quick_phrases: [phrase] },
    })
    expect(store.getSnapshot().phrases).toEqual([phrase])
  })
})
