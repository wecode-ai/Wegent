import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import { adminApis } from '@/apis/admin'
import { KnowledgeBaseRetrievalProfileSection } from '@/features/admin/components/KnowledgeBaseRetrievalProfileSection'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getKnowledgeBaseRetrievalProfile: jest.fn(),
    updateKnowledgeBaseRetrievalProfile: jest.fn(),
  },
}))

jest.mock('@/components/common/CollapsibleSection', () => ({
  CollapsibleSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}))

jest.mock('@/features/knowledge/document/components/RetrievalSettingsSection', () => ({
  RetrievalSettingsSection: () => <div />,
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

describe('KnowledgeBaseRetrievalProfileSection', () => {
  test('disables saving when the current profile cannot be loaded', async () => {
    mockedAdminApis.getKnowledgeBaseRetrievalProfile.mockRejectedValueOnce(
      new Error('profile unavailable')
    )

    render(<KnowledgeBaseRetrievalProfileSection />)

    await waitFor(() => {
      expect(mockedAdminApis.getKnowledgeBaseRetrievalProfile).toHaveBeenCalledTimes(1)
    })
    await screen.findByText('system_config.knowledge_base_profile_load_failed')
    expect(screen.getByTestId('save-knowledge-base-retrieval-profile')).toBeDisabled()
  })
})
