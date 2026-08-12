// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  addSkillToGroups,
  fetchSkillByName,
  scanGitRepoSkills,
  updateSkill,
  updateSkillFromGitRepository,
  uploadSkill,
} from '@/apis/skills'
import {
  downloadSkill as downloadMarketSkill,
  listSkillMarketProviders,
  searchSkills as searchMarketSkills,
} from '@/apis/skillMarketplace'
import SkillUploadModal from '@/features/settings/components/skills/SkillUploadModal'
import { toast } from 'sonner'

jest.mock('@/apis/skills', () => ({
  addSkillToGroups: jest.fn(),
  fetchSkillByName: jest.fn(),
  importGitRepoPublicSkills: jest.fn(),
  importGitRepoSkills: jest.fn(),
  scanGitRepoPublicSkills: jest.fn(),
  scanGitRepoSkills: jest.fn(),
  updatePublicSkillWithUpload: jest.fn(),
  updateSkill: jest.fn(),
  updateSkillFromGitRepository: jest.fn(),
  updatePublicSkillFromGit: jest.fn(),
  updateSkillFromGit: jest.fn(),
  uploadPublicSkill: jest.fn(),
  uploadSkill: jest.fn(),
}))

jest.mock('@/apis/skillMarketplace', () => ({
  downloadSkill: jest.fn(),
  listSkillMarketProviders: jest.fn(),
  searchSkills: jest.fn(),
}))

jest.mock('@/features/resource-library/components/CapabilityScopeSelector', () => ({
  CapabilityScopeSelector: () => null,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('sonner', () => ({
  toast: {
    warning: jest.fn(),
  },
}))

describe('SkillUploadModal partial success', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(fetchSkillByName as jest.Mock).mockResolvedValue(null)
    ;(uploadSkill as jest.Mock).mockResolvedValue({
      id: 55,
      name: 'uploaded-skill',
      namespace: 'default',
    })
    ;(addSkillToGroups as jest.Mock).mockRejectedValue(new Error('Group binding unavailable'))
  })

  it('reports the Skill as saved when a group binding fails', async () => {
    const onClose = jest.fn()
    render(
      <SkillUploadModal
        open
        onClose={onClose}
        createTarget={{
          scope: 'group',
          groupName: 'engineering',
          groupNames: ['engineering'],
        }}
      />
    )
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput!, {
      target: { files: [new File(['zip'], 'uploaded-skill.zip', { type: 'application/zip' })] },
    })

    const uploadButtons = screen.getAllByRole('button', { name: 'actions.upload' })
    fireEvent.click(uploadButtons[uploadButtons.length - 1])

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith(true, 55)
    })
    expect(toast.warning).toHaveBeenCalledWith(
      'resource-library:messages.skill_saved_group_binding_failed'
    )
    expect(screen.queryByText('skills.error_upload_failed')).not.toBeInTheDocument()
  })

  it('filters SkillHub by the current skill name and updates the existing skill', async () => {
    const onClose = jest.fn()
    const user = userEvent.setup()
    ;(listSkillMarketProviders as jest.Mock).mockResolvedValue([{ key: 'weibo', name: 'SkillHub' }])
    ;(searchMarketSkills as jest.Mock).mockResolvedValue({
      total: 2,
      page: 1,
      pageSize: 20,
      skills: [
        {
          skillKey: 'alice_current-skill',
          originalSkillKey: 'current-skill',
          name: 'Current Skill',
          description: 'Matching skill',
          author: 'Alice',
          visibility: 'public',
          tags: [],
          version: '2.0.0',
          downloadCount: 1,
          createdAt: '',
          hasDownloadPermission: true,
          permissionUrl: '',
        },
        {
          skillKey: 'alice_other-skill',
          originalSkillKey: 'other-skill',
          name: 'Other Skill',
          description: 'Non-matching skill',
          author: 'Alice',
          visibility: 'public',
          tags: [],
          version: '1.0.0',
          downloadCount: 1,
          createdAt: '',
          hasDownloadPermission: true,
          permissionUrl: '',
        },
      ],
    })
    ;(downloadMarketSkill as jest.Mock).mockResolvedValue(
      new Blob(['skill archive'], { type: 'application/zip' })
    )
    ;(updateSkill as jest.Mock).mockResolvedValue({
      metadata: { labels: { id: '42' }, name: 'current-skill' },
    })

    render(
      <SkillUploadModal
        open
        onClose={onClose}
        skill={{
          id: 42,
          name: 'current-skill',
          namespace: 'default',
          description: 'Current skill',
          is_active: true,
          is_public: false,
          user_id: 7,
        }}
      />
    )

    await user.click(await screen.findByTestId('skill-update-market-tab'))

    await waitFor(() => {
      expect(searchMarketSkills).toHaveBeenCalledWith('weibo', {
        keyword: 'current-skill',
        page: 1,
        pageSize: 20,
      })
    })
    expect(screen.queryByText('Other Skill')).not.toBeInTheDocument()

    fireEvent.click(await screen.findByTestId('update-skill-from-market-alice_current-skill'))

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledWith(42, expect.any(File), undefined, {
        type: 'marketplace',
        provider_key: 'weibo',
        skill_key: 'alice_current-skill',
        original_skill_key: 'current-skill',
      })
      expect(onClose).toHaveBeenCalledWith(true, 42)
    })
  })

  it('updates the exact skill from a selected Git repository path', async () => {
    const onClose = jest.fn()
    const user = userEvent.setup()
    ;(listSkillMarketProviders as jest.Mock).mockResolvedValue([])
    ;(scanGitRepoSkills as jest.Mock).mockResolvedValue({
      repo_url: 'https://git.example.com/team/skills',
      total_count: 2,
      skills: [
        {
          path: 'skills/current-skill',
          name: 'current-skill',
          description: 'Matching skill',
        },
        {
          path: 'skills/other-skill',
          name: 'other-skill',
          description: 'Other skill',
        },
      ],
    })
    ;(updateSkillFromGitRepository as jest.Mock).mockResolvedValue({
      id: 42,
      name: 'current-skill',
      message: 'updated',
    })

    render(
      <SkillUploadModal
        open
        onClose={onClose}
        skill={{
          id: 42,
          name: 'current-skill',
          namespace: 'default',
          description: 'Current skill',
          is_active: true,
          is_public: false,
          user_id: 7,
        }}
      />
    )

    await user.click(screen.getByTestId('skill-update-git-tab'))
    fireEvent.change(screen.getByLabelText('skills.git_url_label'), {
      target: { value: 'https://git.example.com/team/skills' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'skills.git_scan_button' }))

    await screen.findByText('current-skill')
    expect(screen.queryByText('other-skill')).not.toBeInTheDocument()

    const updateButtons = screen.getAllByRole('button', { name: 'skills.update_from_git' })
    fireEvent.click(updateButtons[updateButtons.length - 1])

    await waitFor(() => {
      expect(updateSkillFromGitRepository).toHaveBeenCalledWith(
        42,
        'https://git.example.com/team/skills',
        'skills/current-skill'
      )
      expect(onClose).toHaveBeenCalledWith(true, 42)
    })
  })

  it('allows changing a saved Git source before updating', async () => {
    const onClose = jest.fn()
    ;(listSkillMarketProviders as jest.Mock).mockResolvedValue([])
    ;(updateSkillFromGitRepository as jest.Mock).mockResolvedValue({
      id: 42,
      name: 'current-skill',
      message: 'updated',
    })

    render(
      <SkillUploadModal
        open
        onClose={onClose}
        skill={{
          id: 42,
          name: 'current-skill',
          namespace: 'default',
          description: 'Current skill',
          is_active: true,
          is_public: false,
          user_id: 7,
          source: {
            type: 'git',
            repo_url: 'https://git.example.com/old/skills',
            skill_path: 'skills/old-skill',
          },
        }}
      />
    )

    expect(screen.getByTestId('skill-update-git-tab')).toHaveAttribute('data-state', 'active')
    fireEvent.change(screen.getByTestId('skill-git-source-url'), {
      target: { value: 'https://git.example.com/new/skills' },
    })
    fireEvent.change(screen.getByTestId('skill-git-source-path'), {
      target: { value: 'packages/current-skill' },
    })
    fireEvent.click(screen.getByTestId('update-skill-from-original-git'))

    await waitFor(() => {
      expect(updateSkillFromGitRepository).toHaveBeenCalledWith(
        42,
        'https://git.example.com/new/skills',
        'packages/current-skill'
      )
      expect(onClose).toHaveBeenCalledWith(true, 42)
    })
  })

  it('shows all SkillHub skills when no same-name skill exists', async () => {
    const user = userEvent.setup()
    ;(listSkillMarketProviders as jest.Mock).mockResolvedValue([{ key: 'weibo', name: 'SkillHub' }])
    ;(searchMarketSkills as jest.Mock)
      .mockResolvedValueOnce({
        total: 0,
        page: 1,
        pageSize: 20,
        skills: [],
      })
      .mockResolvedValueOnce({
        total: 1,
        page: 1,
        pageSize: 100,
        skills: [
          {
            skillKey: 'alice_other-skill',
            originalSkillKey: 'other-skill',
            name: 'Other Skill',
            description: 'Fallback skill',
            author: 'Alice',
            visibility: 'public',
            tags: [],
            version: '1.0.0',
            downloadCount: 1,
            createdAt: '',
            hasDownloadPermission: true,
            permissionUrl: '',
          },
        ],
      })

    render(
      <SkillUploadModal
        open
        onClose={jest.fn()}
        skill={{
          id: 42,
          name: 'missing-skill',
          namespace: 'default',
          description: 'Missing skill',
          is_active: true,
          is_public: false,
          user_id: 7,
        }}
      />
    )

    await user.click(await screen.findByTestId('skill-update-market-tab'))

    expect(await screen.findByText('Other Skill')).toBeInTheDocument()
    expect(searchMarketSkills).toHaveBeenNthCalledWith(2, 'weibo', {
      page: 1,
      pageSize: 100,
    })
    expect(screen.getByText('skills.skill_market_no_match_showing_all')).toBeInTheDocument()
  })

  it('matches SkillHub skills by original key when the display name differs', async () => {
    const user = userEvent.setup()
    ;(listSkillMarketProviders as jest.Mock).mockResolvedValue([{ key: 'weibo', name: 'SkillHub' }])
    ;(searchMarketSkills as jest.Mock)
      .mockResolvedValueOnce({
        total: 0,
        page: 1,
        pageSize: 20,
        skills: [],
      })
      .mockResolvedValueOnce({
        total: 2,
        page: 1,
        pageSize: 100,
        skills: [
          {
            skillKey: 'alice_current-skill',
            originalSkillKey: 'current-skill',
            name: 'Custom Display Name',
            description: 'Matching skill',
            author: 'Alice',
            visibility: 'public',
            tags: [],
            version: '2.0.0',
            downloadCount: 1,
            createdAt: '',
            hasDownloadPermission: true,
            permissionUrl: '',
          },
          {
            skillKey: 'alice_other-skill',
            originalSkillKey: 'other-skill',
            name: 'Other Skill',
            description: 'Non-matching skill',
            author: 'Alice',
            visibility: 'public',
            tags: [],
            version: '1.0.0',
            downloadCount: 1,
            createdAt: '',
            hasDownloadPermission: true,
            permissionUrl: '',
          },
        ],
      })

    render(
      <SkillUploadModal
        open
        onClose={jest.fn()}
        skill={{
          id: 42,
          name: 'current-skill',
          namespace: 'default',
          description: 'Current skill',
          is_active: true,
          is_public: false,
          user_id: 7,
        }}
      />
    )

    await user.click(await screen.findByTestId('skill-update-market-tab'))

    expect(await screen.findByText('Custom Display Name')).toBeInTheDocument()
    expect(screen.queryByText('Other Skill')).not.toBeInTheDocument()
    expect(screen.queryByText('skills.skill_market_no_match_showing_all')).not.toBeInTheDocument()
  })

  it('searches SkillHub from the update dialog', async () => {
    const user = userEvent.setup()
    ;(listSkillMarketProviders as jest.Mock).mockResolvedValue([{ key: 'weibo', name: 'SkillHub' }])
    ;(searchMarketSkills as jest.Mock)
      .mockResolvedValueOnce({
        total: 1,
        page: 1,
        pageSize: 20,
        skills: [
          {
            skillKey: 'alice_current-skill',
            originalSkillKey: 'current-skill',
            name: 'Current Skill',
            description: 'Current skill',
            author: 'Alice',
            visibility: 'public',
            tags: [],
            version: '1.0.0',
            downloadCount: 1,
            createdAt: '',
            hasDownloadPermission: true,
            permissionUrl: '',
          },
        ],
      })
      .mockResolvedValueOnce({
        total: 1,
        page: 1,
        pageSize: 100,
        skills: [
          {
            skillKey: 'alice_weather',
            originalSkillKey: 'weather',
            name: 'Weather Assistant',
            description: 'Weather skill',
            author: 'Alice',
            visibility: 'public',
            tags: [],
            version: '1.0.0',
            downloadCount: 1,
            createdAt: '',
            hasDownloadPermission: true,
            permissionUrl: '',
          },
        ],
      })

    render(
      <SkillUploadModal
        open
        onClose={jest.fn()}
        skill={{
          id: 42,
          name: 'current-skill',
          namespace: 'default',
          description: 'Current skill',
          is_active: true,
          is_public: false,
          user_id: 7,
        }}
      />
    )

    await user.click(await screen.findByTestId('skill-update-market-tab'))
    await user.type(screen.getByTestId('skill-market-update-search'), 'weather')

    await waitFor(() => {
      expect(searchMarketSkills).toHaveBeenLastCalledWith('weibo', {
        keyword: 'weather',
        page: 1,
        pageSize: 100,
      })
    })
    expect(await screen.findByText('Weather Assistant')).toBeInTheDocument()
  })

  it('uses the saved SkillHub skill key for the initial lookup', async () => {
    ;(listSkillMarketProviders as jest.Mock).mockResolvedValue([{ key: 'weibo', name: 'SkillHub' }])
    ;(searchMarketSkills as jest.Mock).mockResolvedValue({
      total: 1,
      page: 1,
      pageSize: 20,
      skills: [
        {
          skillKey: 'zhanglei28_find-skills',
          originalSkillKey: 'find-skills',
          name: 'Find Skills',
          description: 'Find skills',
          author: 'zhanglei28',
          visibility: 'public',
          tags: [],
          version: '1.0.0',
          downloadCount: 1,
          createdAt: '',
          hasDownloadPermission: true,
          permissionUrl: '',
        },
      ],
    })

    render(
      <SkillUploadModal
        open
        onClose={jest.fn()}
        skill={{
          id: 42,
          name: 'find-skills',
          namespace: 'default',
          description: 'Find skills',
          is_active: true,
          is_public: false,
          user_id: 7,
          source: {
            type: 'marketplace',
            provider_key: 'weibo',
            skill_key: 'zhanglei28_find-skills',
            original_skill_key: 'find-skills',
          },
        }}
      />
    )

    expect(await screen.findByTestId('skill-update-market-tab')).toHaveAttribute(
      'data-state',
      'active'
    )

    await waitFor(() => {
      expect(searchMarketSkills).toHaveBeenCalledWith('weibo', {
        keyword: 'zhanglei28_find-skills',
        page: 1,
        pageSize: 20,
      })
    })
  })
})
