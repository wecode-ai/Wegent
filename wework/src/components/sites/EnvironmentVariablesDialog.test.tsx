import { ApiError } from '@/api/http'
import {
  createUnavailableSitesApi,
  type EnvironmentSnapshot,
  type EnvironmentRevision,
  type Site,
} from '@/api/sites'
import '@/i18n'
import i18n from 'i18next'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { EnvironmentVariablesDialog } from './EnvironmentVariablesDialog'

const site = { siteid: 'site-a', name: 'A' } as Site
const onClose = vi.fn()
function snapshot(project = 'site-a', value = 'original'): EnvironmentSnapshot {
  return {
    revision_id: `${project}-1`,
    project_id: project,
    revision_number: 1,
    items: [
      { key: 'PUBLIC_URL', type: 'plain', value, updated_by: 'owner', updated_at: '' },
      { key: 'API_TOKEN', type: 'secret', configured: true, updated_by: 'owner', updated_at: '' },
    ],
  }
}
function revision(data: EnvironmentSnapshot): EnvironmentRevision {
  return {
    id: `${data.project_id}-2`,
    project_id: data.project_id,
    revision_number: 2,
    variables: data.items,
    created_by: 'owner',
    created_at: '',
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const valueInput = () => screen.getByTestId('environment-value-PUBLIC_URL-0')

describe('environment variables dialog request ownership', () => {
  test('saves only edited values with the loaded revision and retains masked secrets', async () => {
    const get = vi.fn().mockResolvedValue(snapshot())
    const patch = vi.fn().mockResolvedValue(revision(snapshot('site-a', 'edited')))
    const api = {
      ...createUnavailableSitesApi(),
      getEnvironmentVariables: get,
      patchEnvironmentVariables: patch,
    }
    render(<EnvironmentVariablesDialog api={api} site={site} onClose={onClose} />)
    await screen.findByDisplayValue('original')
    expect(screen.getByTestId('environment-value-API_TOKEN-1')).toHaveValue('')
    await userEvent.clear(valueInput())
    await userEvent.type(valueInput(), 'edited')
    await userEvent.click(screen.getByTestId('environment-save-button'))
    expect(await screen.findByRole('status')).toHaveTextContent('已保存')
    expect(patch).toHaveBeenCalledWith(
      'site-a',
      {
        expected_revision_id: 'site-a-1',
        operations: [{ op: 'upsert', key: 'PUBLIC_URL', type: 'plain', value: 'edited' }],
      },
      expect.any(String)
    )
    expect(screen.getByTestId('environment-save-button')).toBeDisabled()
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('retains a draft across language changes without another request', async () => {
    const get = vi.fn().mockResolvedValue(snapshot())
    const api = { ...createUnavailableSitesApi(), getEnvironmentVariables: get }
    render(<EnvironmentVariablesDialog api={api} site={site} onClose={onClose} />)
    await screen.findByDisplayValue('original')
    await userEvent.type(valueInput(), '-draft')
    const language = i18n.language
    try {
      await act(() => i18n.changeLanguage(language.startsWith('en') ? 'zh-CN' : 'en'))
      expect(valueInput()).toHaveValue('original-draft')
      expect(get).toHaveBeenCalledTimes(1)
    } finally {
      await act(() => i18n.changeLanguage(language))
    }
  })

  test('ignores a replaced API read and an old site save after changing scope', async () => {
    const oldRead = deferred<EnvironmentSnapshot>()
    const oldApi = {
      ...createUnavailableSitesApi(),
      getEnvironmentVariables: vi.fn(() => oldRead.promise),
    }
    const saving = deferred<EnvironmentRevision>()
    const api = {
      ...createUnavailableSitesApi(),
      getEnvironmentVariables: vi.fn((id: string) => Promise.resolve(snapshot(id, id))),
      patchEnvironmentVariables: vi.fn(() => saving.promise),
    }
    const view = render(<EnvironmentVariablesDialog api={oldApi} site={site} onClose={onClose} />)
    view.rerender(<EnvironmentVariablesDialog api={api} site={site} onClose={onClose} />)
    await screen.findByDisplayValue('site-a')
    await act(async () => {
      oldRead.resolve(snapshot('site-a', 'stale-read'))
    })
    expect(valueInput()).toHaveValue('site-a')
    await userEvent.type(valueInput(), '-draft')
    await userEvent.click(screen.getByTestId('environment-save-button'))
    await waitFor(() => expect(api.patchEnvironmentVariables).toHaveBeenCalledTimes(1))
    const otherSite = { ...site, siteid: 'site-b', name: 'B' }
    view.rerender(<EnvironmentVariablesDialog api={api} site={otherSite} onClose={onClose} />)
    await screen.findByDisplayValue('site-b')
    await userEvent.type(valueInput(), '-draft')
    await act(async () => {
      saving.resolve(revision(snapshot('site-a', 'stale-save')))
    })
    expect(valueInput()).toHaveValue('site-b-draft')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByTestId('environment-save-button')).toBeEnabled()
  })

  test('keeps edits on revision conflicts and replaces them only after explicit reload', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValue(snapshot('site-a', 'remote'))
    const api = {
      ...createUnavailableSitesApi(),
      getEnvironmentVariables: get,
      patchEnvironmentVariables: vi
        .fn()
        .mockRejectedValue(new ApiError('conflict', 409, 'ENVIRONMENT_REVISION_CONFLICT')),
    }
    render(<EnvironmentVariablesDialog api={api} site={site} onClose={onClose} />)
    await screen.findByDisplayValue('original')
    await userEvent.type(valueInput(), '-draft')
    await userEvent.click(screen.getByTestId('environment-save-button'))
    expect(await screen.findByRole('alert')).toHaveTextContent('配置已被其他操作更新')
    expect(valueInput()).toHaveValue('original-draft')
    await userEvent.click(screen.getByTestId('environment-reload-button'))
    await screen.findByDisplayValue('remote')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('environment-save-button')).toBeDisabled()
    expect(get).toHaveBeenCalledTimes(2)
  })
})
