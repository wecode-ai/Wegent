// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { addSkillToGroups, fetchSkillByName, uploadSkill } from '@/apis/skills'
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
})
