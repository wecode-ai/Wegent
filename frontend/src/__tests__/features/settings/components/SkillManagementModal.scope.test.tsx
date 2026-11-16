// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { downloadSkill, fetchUnifiedSkillsList, type UnifiedSkill } from '@/apis/skills'
import SkillManagementModal from '@/features/settings/components/skills/SkillManagementModal'

const mockToast = jest.fn()
const translations: Record<string, string> = {
  'common:skills.upload_skill': '上传技能',
  'settings:skills.source.personal': '我的技能',
  'settings:skills.source.group': '团队技能',
  'settings:skills.source.system': '系统技能',
}
const mockT = (key: string) => translations[key] || key

jest.mock('@/apis/skills', () => ({
  addSkillToMyDefault: jest.fn(),
  deletePublicSkill: jest.fn(),
  deleteSkill: jest.fn(),
  downloadPublicSkill: jest.fn(),
  downloadSkill: jest.fn(),
  fetchPublicSkillsList: jest.fn(),
  fetchSkillReferences: jest.fn(),
  fetchUnifiedSkillsList: jest.fn(),
  parseSkillReferenceError: jest.fn(),
  removeSingleSkillReference: jest.fn(),
  removeSkillFromMyDefault: jest.fn(),
  removeSkillReferences: jest.fn(),
  updatePublicSkillFromGit: jest.fn(),
  updateSkillFromGit: jest.fn(),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: 1, role: 'user' } }),
}))

jest.mock('@/features/settings/components/skills/SkillUploadModal', () => {
  function MockSkillUploadModal({
    open,
    namespace,
    skill,
  }: {
    open: boolean
    namespace?: string
    skill?: UnifiedSkill | null
  }) {
    return open ? (
      <div
        data-testid="skill-upload-modal"
        data-namespace={namespace || ''}
        data-skill={skill?.name || ''}
      />
    ) : null
  }

  return MockSkillUploadModal
})

jest.mock('@/features/settings/components/skills/SkillReferenceConflictDialog', () => ({
  SkillReferenceConflictDialog: () => null,
}))

jest.mock('@/features/resource-library/components/MarketplaceTagsDialog', () => ({
  MarketplaceTagsDialog: () => null,
}))

const mockedFetchUnifiedSkillsList = fetchUnifiedSkillsList as jest.MockedFunction<
  typeof fetchUnifiedSkillsList
>
const mockedDownloadSkill = downloadSkill as jest.MockedFunction<typeof downloadSkill>

function makeSkill(overrides: Partial<UnifiedSkill>): UnifiedSkill {
  return {
    id: 1,
    name: 'skill',
    namespace: 'default',
    description: '',
    is_active: true,
    is_public: false,
    user_id: 1,
    ...overrides,
  }
}

describe('SkillManagementModal scope', () => {
  const personalSkill = makeSkill({
    id: 101,
    name: 'sass-stability-monitor',
    namespace: 'default',
  })
  const groupSkill = makeSkill({
    id: 202,
    name: 'moodly-get-data',
    namespace: 'moodly',
  })
  const boundPublicSkill = makeSkill({
    id: 303,
    name: 'public-skill-bound-to-team',
    namespace: 'default',
    user_id: 0,
    is_group_shared: true,
  })
  const sharedToAnotherGroupSkill = makeSkill({
    id: 404,
    name: 'personal-skill-shared-elsewhere',
    namespace: 'default',
    is_group_shared: true,
  })
  const duplicatedGroupSkill = makeSkill({
    id: 505,
    name: 'duplicated-group-skill',
    namespace: 'moodly',
    is_public: false,
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockedFetchUnifiedSkillsList.mockImplementation(async params => {
      if (params?.scope === 'personal') {
        return [
          personalSkill,
          sharedToAnotherGroupSkill,
          { ...duplicatedGroupSkill, is_public: true },
        ]
      }
      if (params?.scope === 'group') {
        return [groupSkill, boundPublicSkill, duplicatedGroupSkill]
      }
      return []
    })
  })

  it('shows personal and group skills together when managing a group agent', async () => {
    const user = userEvent.setup()

    render(<SkillManagementModal open onClose={jest.fn()} scope="group" />)

    expect(await screen.findByText('sass-stability-monitor')).toBeInTheDocument()
    expect(screen.getByText('moodly-get-data')).toBeInTheDocument()
    expect(screen.getByText('public-skill-bound-to-team')).toBeInTheDocument()
    expect(screen.getByText('personal-skill-shared-elsewhere')).toBeInTheDocument()
    expect(screen.getByText('duplicated-group-skill')).toBeInTheDocument()
    expect(screen.getByTestId('managed-skill-source-101')).toHaveTextContent('我的技能')
    expect(screen.getByTestId('managed-skill-source-202')).toHaveTextContent('团队技能 · moodly')
    expect(screen.getByTestId('managed-skill-source-303')).toHaveTextContent('团队技能')
    expect(screen.getByTestId('managed-skill-source-404')).toHaveTextContent('我的技能')
    expect(screen.getByTestId('managed-skill-source-505')).toHaveTextContent('团队技能 · moodly')
    expect(mockedFetchUnifiedSkillsList).toHaveBeenCalledWith({ scope: 'personal' })
    expect(mockedFetchUnifiedSkillsList).toHaveBeenCalledWith({
      scope: 'group',
      groupName: undefined,
    })

    await user.click(screen.getByRole('button', { name: '上传技能' }))

    expect(screen.getByTestId('skill-upload-modal')).toHaveAttribute('data-namespace', '')
  })

  it('uses the skill namespace for personal skill actions in a group-scoped manager', async () => {
    const user = userEvent.setup()

    render(<SkillManagementModal open onClose={jest.fn()} scope="group" groupName="rcdp" />)

    await screen.findByText('sass-stability-monitor')

    await user.click(screen.getByTestId('download-skill-button-101'))

    expect(mockedDownloadSkill).toHaveBeenCalledWith(
      personalSkill.id,
      personalSkill.name,
      'default'
    )

    await user.click(screen.getByTestId('edit-skill-button-101'))

    expect(screen.getByTestId('skill-upload-modal')).toHaveAttribute('data-namespace', 'default')
    expect(screen.getByTestId('skill-upload-modal')).toHaveAttribute(
      'data-skill',
      'sass-stability-monitor'
    )
  })
})
