// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OpenMenu from '@/features/tasks/components/input/OpenMenu'
import type { TaskDetail, WorkbenchData } from '@/types/api'
import { calculateOpenLinks } from '@/utils/openLinks'

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => ({ vscodeLinkTemplate: '' }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'common:tasks.open_from': 'Code',
        'common:tasks.open_from_vscode': 'VSCode',
        'common:tasks.open_from_git': 'Git',
      }
      return labels[key] || key
    },
  }),
}))

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 1,
    git_url: 'https://github.com/owner/repository.git',
    git_repo: 'owner/repository',
    git_domain: 'github.com',
    branch_name: 'main',
    ...overrides,
  } as TaskDetail
}

describe('Code menu links', () => {
  it.each([null, undefined])('omits links when the task is %s', detail => {
    expect(calculateOpenLinks(detail)).toBeNull()
  })

  it('keeps Git disabled when the task has no repository URL', () => {
    expect(calculateOpenLinks(task({ git_url: '' }))?.git_link).toBeNull()
  })

  it.each([
    ['github.com', 'https://github.com/owner/repository/compare/main...feature/change'],
    [
      'gitlab.example.test',
      'https://gitlab.example.test/owner/repository/-/merge_requests/new?merge_request[source_branch]=feature/change&merge_request[target_branch]=main',
    ],
  ])('retains the historical compare link on %s', (domain, expected) => {
    const workbench = {
      git_info: { source_branch: 'main', target_branch: 'feature/change' },
    } as WorkbenchData

    expect(calculateOpenLinks(task({ git_domain: domain, workbench }))?.git_link).toBe(expected)
  })

  it('opens the task repository without workbench metadata and clears links on task change', async () => {
    const user = userEvent.setup()
    const open = jest.spyOn(window, 'open').mockImplementation(() => null)
    const detail = task()
    const links = calculateOpenLinks(detail, 'executor-1')
    const { rerender } = render(<OpenMenu openLinks={links} />)

    try {
      expect(links?.git_link).toBe(detail.git_url)
      await user.click(screen.getByRole('button', { name: 'Code' }))
      expect(screen.getByRole('menuitem', { name: 'VSCode' })).toBeDisabled()
      const git = screen.getByRole('menuitem', { name: 'Git' })
      expect(git).toBeEnabled()
      await user.click(git)
      expect(open).toHaveBeenCalledWith(detail.git_url, '_blank', 'noopener,noreferrer')

      rerender(<OpenMenu openLinks={calculateOpenLinks(task({ id: 2, git_url: '' }))} />)
      await user.click(screen.getByRole('button', { name: 'Code' }))
      const unavailableGit = screen.getByRole('menuitem', { name: 'Git' })
      expect(unavailableGit).toBeDisabled()
      expect(screen.getByRole('menuitem', { name: 'VSCode' })).toBeDisabled()
      fireEvent.click(unavailableGit)
      expect(open).toHaveBeenCalledTimes(1)
    } finally {
      open.mockRestore()
    }
  })
})
