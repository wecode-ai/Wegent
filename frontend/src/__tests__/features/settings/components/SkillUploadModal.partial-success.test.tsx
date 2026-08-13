// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  addSkillToGroups,
  fetchSkillByName,
  scanGitRepoSkills,
  updateSkillFromGitRepository,
  uploadSkill,
} from '@/apis/skills'
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

  it('updates the exact skill from a selected Git repository path', async () => {
    const onClose = jest.fn()
    const user = userEvent.setup()
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
      version: '2.0.0',
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

    fireEvent.click(screen.getByTestId('git-import-submit'))

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
    ;(updateSkillFromGitRepository as jest.Mock).mockResolvedValue({
      id: 42,
      name: 'current-skill',
      version: '2.0.0',
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

  it('disables updating a saved Git source with an invalid repository URL', () => {
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
          source: {
            type: 'git',
            repo_url: 'https://git.example.com/old/skills',
            skill_path: 'skills/current-skill',
          },
        }}
      />
    )

    fireEvent.change(screen.getByTestId('skill-git-source-url'), {
      target: { value: 'not-a-repository-url' },
    })

    expect(screen.getByTestId('update-skill-from-original-git')).toBeDisabled()
  })
})
