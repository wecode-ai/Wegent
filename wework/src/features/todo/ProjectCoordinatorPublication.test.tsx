import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ProjectCoordinatorPublication } from './ProjectCoordinatorPublication'
import type { StandInSettingsHandle } from './StandInSettingsPage'

function fixture() {
  const project = { id: 'project-a', name: '项目 A', project_store: 'local' }
  const issue = {
    id: 'issue-a',
    title: '共享工作',
    cloud_project_id: 'project-a',
    can_view_detail: true,
  }
  const list = vi
    .fn()
    .mockResolvedValue([
      issue,
      { ...issue, id: 'foreign', title: '其他项目', cloud_project_id: 'project-b' },
      { ...issue, id: 'hidden', title: '不可访问', can_view_detail: false },
    ])
  const getProject = vi.fn().mockResolvedValue(project)
  const getIssue = vi.fn().mockResolvedValue(issue)
  const create = vi.fn().mockResolvedValue({ id: 'comment', body: '明确发布的结论' })
  const onClose = vi.fn()
  const onPublished = vi.fn()
  const ref = createRef<StandInSettingsHandle>()
  const props = {
    api: { projects: { get: getProject }, issues: { list, get: getIssue }, comments: { create } },
    project,
    onClose,
    onPublished,
    ref,
  } as unknown as ComponentProps<typeof ProjectCoordinatorPublication>
  return { props, project, issue, list, getProject, getIssue, create, onClose, ref }
}

async function enterPublication() {
  const user = userEvent.setup()
  await screen.findByRole('option', { name: '共享工作' })
  await user.selectOptions(screen.getByTestId('project-coordinator-publication-target'), 'issue-a')
  await user.type(screen.getByTestId('project-coordinator-publication-content'), '明确发布的结论')
  return user
}

describe('explicit project publication', () => {
  it('refreshes its owning board only after the publication is committed', async () => {
    const f = fixture()
    const onPublished = vi.fn()
    let finish!: () => void
    f.create.mockReturnValue(
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    render(<ProjectCoordinatorPublication {...f.props} onPublished={onPublished} />)
    const user = await enterPublication()
    await user.click(screen.getByTestId('project-coordinator-publication-submit'))
    expect(f.create).toHaveBeenCalledOnce()
    expect(onPublished).not.toHaveBeenCalled()
    await act(async () => finish())
    await screen.findByTestId('project-coordinator-published')
    expect(onPublished).toHaveBeenCalledOnce()
  })

  it('does not refresh its owning board when publication is rejected', async () => {
    const f = fixture()
    const onPublished = vi.fn()
    f.create.mockRejectedValue(new Error('permission_denied'))
    render(<ProjectCoordinatorPublication {...f.props} onPublished={onPublished} />)
    const user = await enterPublication()
    await user.click(screen.getByTestId('project-coordinator-publication-submit'))
    await screen.findByRole('alert')
    expect(onPublished).not.toHaveBeenCalled()
  })

  it('shares only entered text after an explicit publish and retains the normal Issue record', async () => {
    const f = fixture()
    render(<ProjectCoordinatorPublication {...f.props} />)
    const user = await enterPublication()
    expect(f.create).not.toHaveBeenCalled()
    expect(screen.queryByRole('option', { name: '其他项目' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '不可访问' })).not.toBeInTheDocument()
    await user.click(screen.getByTestId('project-coordinator-publication-submit'))
    await screen.findByTestId('project-coordinator-published')
    expect(f.getProject).toHaveBeenCalledWith('project-a')
    expect(f.getIssue).toHaveBeenCalledWith('issue-a')
    expect(f.create).toHaveBeenCalledExactlyOnceWith('issue-a', '明确发布的结论')
    await user.click(screen.getByTestId('project-coordinator-publication-close'))
    expect(f.onClose).toHaveBeenCalledOnce()
  })

  it.each(['revoked', 'foreign', 'archived'] as const)(
    'rejects %s targets on fresh permission reads and preserves the draft',
    async kind => {
      const f = fixture()
      render(<ProjectCoordinatorPublication {...f.props} />)
      const user = await enterPublication()
      if (kind === 'revoked')
        f.getProject.mockResolvedValue({ ...f.project, access_role: 'Viewer' })
      if (kind === 'foreign')
        f.getIssue.mockResolvedValue({ ...f.issue, cloud_project_id: 'project-b' })
      if (kind === 'archived')
        f.getIssue.mockResolvedValue({ ...f.issue, archived_at: '2026-11-02' })
      await user.click(screen.getByTestId('project-coordinator-publication-submit'))
      await screen.findByRole('alert')
      expect(f.create).not.toHaveBeenCalled()
      expect(screen.getByTestId('project-coordinator-publication-content')).toHaveValue(
        '明确发布的结论'
      )
    }
  )

  it('keeps or discards unsent content through the shared navigation guard without publishing', async () => {
    const f = fixture()
    render(<ProjectCoordinatorPublication {...f.props} />)
    const user = await enterPublication()
    await user.click(screen.getByTestId('project-coordinator-publication-cancel'))
    await user.click(screen.getByTestId('project-coordinator-publication-keep'))
    expect(f.onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-coordinator-publication-content')).toHaveValue(
      '明确发布的结论'
    )
    await user.click(screen.getByTestId('project-coordinator-publication-cancel'))
    await user.click(screen.getByTestId('project-coordinator-publication-discard'))
    expect(f.onClose).toHaveBeenCalledOnce()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('does not duplicate a pending publication or close while the write is pending', async () => {
    const f = fixture()
    let finish!: () => void
    f.create.mockReturnValue(
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    render(<ProjectCoordinatorPublication {...f.props} />)
    const user = await enterPublication()
    await user.dblClick(screen.getByTestId('project-coordinator-publication-submit'))
    await waitFor(() => expect(f.create).toHaveBeenCalledOnce())
    act(() => f.ref.current?.requestLeave(f.onClose))
    expect(f.onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-coordinator-publication-cancel')).toBeDisabled()
    await act(async () => finish())
    await screen.findByTestId('project-coordinator-published')
  })

  it('retains unsent content on a rejected write and never retries automatically', async () => {
    const f = fixture()
    f.create.mockRejectedValue(new Error('permission_denied'))
    render(<ProjectCoordinatorPublication {...f.props} />)
    const user = await enterPublication()
    await user.click(screen.getByTestId('project-coordinator-publication-submit'))
    await screen.findByRole('alert')
    expect(screen.getByTestId('project-coordinator-publication-content')).toHaveValue(
      '明确发布的结论'
    )
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.onClose).not.toHaveBeenCalled()
  })
})
