import '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { Site, SitesApi, SiteAccessPolicy, SiteCollaborator } from '@/api/sites'
import { createSiteCollaboratorsResource } from './siteCollaboratorsResource'
import { SiteAccessDialog } from './SiteAccessDialog'
import { SiteCollaboratorsDialog } from './SiteCollaboratorsDialog'

const site = { siteid: 'site-a', name: 'Site A' } as Site
const policy: SiteAccessPolicy = {
  id: 'policy',
  project_id: 'project',
  target: 'inner',
  audience: 'owner',
  subjects: [],
  revision_number: 1,
  created_by: 'owner',
  created_at: '',
}
const member: SiteCollaborator = { subject: 'member', added_by: 'owner', created_at: '' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}
function source() {
  const methods = {
    getSiteAccess: vi.fn().mockResolvedValue(policy),
    updateSiteAccess: vi.fn().mockResolvedValue(policy),
    listCollaborators: vi.fn().mockResolvedValue({ items: [member] }),
    addCollaborator: vi.fn().mockResolvedValue({ ...member, subject: 'new-member' }),
    removeCollaborator: vi.fn().mockResolvedValue(undefined),
  }
  return { ...methods, api: methods as unknown as SitesApi }
}

test('keeps failed access reads unsavable and retries only on request', async () => {
  const f = source()
  f.getSiteAccess.mockRejectedValueOnce(new Error('Offline'))
  render(<SiteAccessDialog api={f.api} site={site} onClose={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
  expect(screen.getByTestId('site-access-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('site-access-retry'))
  await waitFor(() => expect(screen.getByTestId('site-access-save')).toBeEnabled())
  expect(f.getSiteAccess).toHaveBeenCalledTimes(2)
})

test('resets access drafts and ignores late old-owner saves', async () => {
  const old = source(),
    next = source(),
    pending = deferred<SiteAccessPolicy>()
  old.updateSiteAccess.mockReturnValue(pending.promise)
  const { rerender } = render(<SiteAccessDialog api={old.api} site={site} onClose={vi.fn()} />)
  await screen.findByTestId('site-access-audience-custom')
  fireEvent.click(screen.getByTestId('site-access-audience-custom'))
  fireEvent.change(screen.getByTestId('site-access-subjects'), { target: { value: 'alice' } })
  fireEvent.click(screen.getByTestId('site-access-save'))
  fireEvent.click(screen.getByTestId('site-access-save'))
  expect(old.updateSiteAccess).toHaveBeenCalledTimes(1)
  rerender(
    <SiteAccessDialog api={next.api} site={{ ...site, siteid: 'site-b' }} onClose={vi.fn()} />
  )
  await screen.findByTestId('site-access-audience-owner')
  expect(screen.getByTestId('site-access-audience-owner')).toBeChecked()
  await act(async () => pending.resolve({ ...policy, audience: 'custom', subjects: ['alice'] }))
  expect(screen.getByTestId('site-access-audience-owner')).toBeChecked()
  expect(next.updateSiteAccess).not.toHaveBeenCalled()
})

test('traps access focus, refuses Escape during save and restores the opener', async () => {
  const f = source(),
    pending = deferred<SiteAccessPolicy>(),
    close = vi.fn()
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const { unmount } = render(<SiteAccessDialog api={f.api} site={site} onClose={close} />)
  await waitFor(() => expect(screen.getByTestId('site-access-close')).toHaveFocus())
  await screen.findByTestId('site-access-audience-owner')
  f.updateSiteAccess.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByTestId('site-access-save'))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  await act(async () => pending.resolve(policy))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  unmount()
  await waitFor(() => expect(opener).toHaveFocus())
  opener.remove()
})

test('does not present failed collaborator reads as an empty list and permits retry', async () => {
  const f = source()
  f.listCollaborators.mockRejectedValueOnce(new Error('Members offline'))
  render(<SiteCollaboratorsDialog api={f.api} site={site} onClose={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Members offline')
  expect(screen.queryByTestId('site-collaborator-remove-member')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('site-collaborators-retry'))
  await screen.findByTestId('site-collaborator-remove-member')
  expect(f.listCollaborators).toHaveBeenCalledTimes(2)
})

test('preserves an accepted addition when an older initial list arrives', async () => {
  const f = source(),
    pending = deferred<{ items: SiteCollaborator[] }>()
  f.listCollaborators.mockReturnValueOnce(pending.promise)
  render(<SiteCollaboratorsDialog api={f.api} site={site} onClose={vi.fn()} />)
  fireEvent.change(screen.getByTestId('site-collaborator-subject-input'), {
    target: { value: 'new-member' },
  })
  fireEvent.click(screen.getByTestId('site-collaborator-add'))
  await waitFor(() => expect(screen.getByTestId('site-collaborator-subject-input')).toHaveValue(''))
  await act(async () => pending.resolve({ items: [member] }))
  expect(screen.getByTestId('site-collaborator-remove-member')).toBeInTheDocument()
  expect(screen.getByTestId('site-collaborator-remove-new-member')).toBeInTheDocument()
  expect(f.listCollaborators).toHaveBeenCalledOnce()
})

test('rejects old-owner member data and resets the unsent subject on site change', async () => {
  const f = source(),
    pending = deferred<{ items: SiteCollaborator[] }>()
  f.listCollaborators.mockReturnValueOnce(pending.promise).mockResolvedValue({ items: [] })
  const { rerender } = render(<SiteCollaboratorsDialog api={f.api} site={site} onClose={vi.fn()} />)
  fireEvent.change(screen.getByTestId('site-collaborator-subject-input'), {
    target: { value: 'old draft' },
  })
  rerender(
    <SiteCollaboratorsDialog api={f.api} site={{ ...site, siteid: 'site-b' }} onClose={vi.fn()} />
  )
  expect(screen.getByTestId('site-collaborator-subject-input')).toHaveValue('')
  await act(async () => pending.resolve({ items: [member] }))
  expect(screen.queryByTestId('site-collaborator-remove-member')).not.toBeInTheDocument()
  expect(f.listCollaborators).toHaveBeenLastCalledWith('site-b')
})

test('restores the original opener after changing the modal owner', async () => {
  const old = source(),
    next = source()
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const { rerender, unmount } = render(
    <SiteAccessDialog api={old.api} site={site} onClose={vi.fn()} />
  )
  await screen.findByTestId('site-access-audience-owner')
  rerender(<SiteAccessDialog api={next.api} site={site} onClose={vi.fn()} />)
  await screen.findByTestId('site-access-audience-owner')
  unmount()
  await waitFor(() => expect(opener).toHaveFocus())
  opener.remove()
})

test('accepts a fresh authoritative list after a collaborator was removed elsewhere', async () => {
  const f = source()
  const resource = createSiteCollaboratorsResource(f.api, site.siteid)
  const stop = resource.subscribe(() => {})
  try {
    await waitFor(() => expect(resource.getSnapshot().loading).toBe(false))
    resource.accept('new-member', { ...member, subject: 'new-member' })
    expect(resource.getSnapshot().items.some(item => item.subject === 'new-member')).toBe(true)
    await resource.reload()
    expect(resource.getSnapshot().items).toEqual([member])
  } finally {
    stop()
  }
})
