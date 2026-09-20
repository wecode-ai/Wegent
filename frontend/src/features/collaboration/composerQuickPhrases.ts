import {
  createQuickPhrasePreferencesStore,
  defaultQuickPhrases,
  type QuickPhrase,
} from '@wegent/chat-core/composer-quick-phrases'
import type { WebWorkspaceHttpClient } from './shared-api/webSharedWorkspaceApi'

type StoredPhrase = Omit<QuickPhrase, 'attachmentPaths' | 'createdAt'> & {
  attachmentPaths?: string[] | null
  createdAt?: number | null
}
type PreferenceResponse = { preferences?: { composer_quick_phrases?: StoredPhrase[] | null } }

function fromResponse(phrases: StoredPhrase[]): QuickPhrase[] {
  return phrases.map(({ attachmentPaths, createdAt, ...phrase }) => ({
    ...phrase,
    ...(attachmentPaths != null ? { attachmentPaths } : {}),
    ...(createdAt != null ? { createdAt } : {}),
  }))
}

/** Account-owned composer preferences; absence uses the same PC defaults. */
export function createWebComposerQuickPhrases(client: Pick<WebWorkspaceHttpClient, 'get' | 'put'>) {
  return createQuickPhrasePreferencesStore({
    async load() {
      const user = await client.get<PreferenceResponse>('/users/me')
      return fromResponse(user.preferences?.composer_quick_phrases ?? defaultQuickPhrases)
    },
    async save(phrases) {
      const user = await client.put<PreferenceResponse>('/users/me', {
        preferences: { composer_quick_phrases: phrases },
      })
      if (!user.preferences?.composer_quick_phrases)
        throw new Error('Missing saved composer preferences')
      return fromResponse(user.preferences.composer_quick_phrases)
    },
  })
}
