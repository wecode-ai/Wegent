// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { fetchMyDefaultSkillBindings, fetchUnifiedSkillsList } from '@/apis/skills'
import { SkillListWithScope } from '@/features/settings/components/SkillListWithScope'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'actions.cancel': 'Cancel',
        'actions.confirm': 'Confirm',
        'skills.author': 'Author',
        'skills.description': 'Manage skills.',
        'skills.loading': 'Loading',
        'skills.no_skills': 'No skills',
        'skills.no_skills_hint': 'Upload one first.',
        'skills.public_readonly': 'Readonly',
        'skills.system_skill': 'System',
        'skills.title': 'Skill List',
        'skills.upload_first_skill': 'Upload first',
        'skills.upload_skill': 'Upload skill',
        'skills.view_references': 'View references',
        'resource-library:actions.publish_to_library': 'Publish to library',
      }

      if (key === 'skills.no_references_found') {
        return `No references for ${String(params?.skillName ?? '')}`
      }

      return translations[key] ?? key
    },
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { id: 1, role: 'user' },
  }),
}))

jest.mock('@/apis/skills', () => ({
  addSkillToMyDefault: jest.fn(),
  fetchUnifiedSkillsList: jest.fn(),
  fetchMyDefaultSkillBindings: jest.fn(),
  deleteSkill: jest.fn(),
  downloadSkill: jest.fn(),
  fetchSkillReferences: jest.fn(),
  removeSkillFromMyDefault: jest.fn(),
  removeSkillReferences: jest.fn(),
  removeSingleSkillReference: jest.fn(),
  parseSkillReferenceError: jest.fn(),
  updateSkillFromGit: jest.fn(),
  batchUpdateSkillsFromGit: jest.fn(),
}))

jest.mock('@/apis/skillMarket', () => ({
  checkSkillMarketAvailable: jest.fn().mockResolvedValue({ available: false }),
}))

jest.mock('@/apis/groups', () => ({
  getGroup: jest.fn(),
}))

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
  },
}))

jest.mock('@/features/settings/components/skills/SkillUploadModal', () => () => null)
jest.mock('@/features/settings/components/skills/SkillSearchModal', () => () => null)
jest.mock('@/features/settings/components/skills/SkillReferenceConflictDialog', () => ({
  SkillReferenceConflictDialog: () => null,
}))

describe('SkillListWithScope publishing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(fetchUnifiedSkillsList as jest.Mock).mockResolvedValue([
      {
        id: 22,
        name: 'skill-one',
        namespace: 'default',
        description: 'Skill desc',
        displayName: 'Skill One',
        tags: ['chat'],
        is_active: true,
        is_public: false,
        user_id: 1,
      },
    ])
    ;(fetchMyDefaultSkillBindings as jest.Mock).mockResolvedValue([])
  })

  it('publishes a selected personal skill through the callback', async () => {
    const onPublishResource = jest.fn()

    render(<SkillListWithScope scope="personal" onPublishResource={onPublishResource} />)

    await screen.findByText('Skill One')
    await userEvent.click(screen.getByTestId('publish-skill-22-button'))

    expect(onPublishResource).toHaveBeenCalledWith({
      resourceType: 'skill',
      sourceId: 22,
      name: 'skill-one',
      displayName: 'Skill One',
      description: 'Skill desc',
      tags: ['chat'],
      namespace: 'default',
    })
  })
})
