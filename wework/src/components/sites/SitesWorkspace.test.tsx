import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ApiError } from '@/api/http'
import type { SiteListResponse, SiteProject, SitesApi } from '@/api/sites'
import { openExternalUrl } from '@/lib/external-links'
import { SitesWorkspace } from './SitesWorkspace'

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn().mockResolvedValue(true),
}))

const innerProject: SiteProject = {
  id: 'prj-site-1',
  network: 'inner',
  title: '产品发布页',
  url: 'http://sites.internal/product',
  snapshot: 'https://snapshots.example.site/product.png',
  created_at: '2026-07-15T04:00:00Z',
}

const outerProject: SiteProject = {
  ...innerProject,
  network: 'outer',
  url: 'https://product.example.site',
}

function createApi(
  items: SiteProject[] = [innerProject],
  nextCursor: string | null = null
): SitesApi {
  return {
    listSites: vi.fn().mockResolvedValue({ items, next_cursor: nextCursor }),
    publishSite: vi.fn().mockResolvedValue(outerProject),
    renameSite: vi.fn().mockResolvedValue(innerProject),
    deleteSite: vi.fn().mockResolvedValue(undefined),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('SitesWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('shows an unavailable product state when Backend reports Sites is not configured', async () => {
    const api = createApi()
    vi.mocked(api.listSites).mockRejectedValueOnce(
      new ApiError('Sites is not available yet', 503, 'sites_not_available')
    )
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)

    expect(await screen.findByTestId('sites-unavailable-state')).toHaveTextContent(
      '站点功能尚未推出'
    )
    expect(screen.queryByTestId('site-row-prj-site-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sites-refresh-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sites-create-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sites-search-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sites-retry-button')).not.toBeInTheDocument()
    expect(screen.queryByText('网络访问')).not.toBeInTheDocument()
  })

  test('loads a project snapshot and opens its accessible internal URL', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)

    const row = await screen.findByTestId('site-row-prj-site-1')
    expect(row).toHaveTextContent('产品发布页')
    expect(row.querySelector('img')).toHaveAttribute(
      'src',
      'https://snapshots.example.site/product.png'
    )
    expect(api.listSites).toHaveBeenCalledWith({
      q: '',
      cursor: null,
      limit: 20,
    })

    const urlButton = screen.getByRole('button', { name: '打开内部站点 产品发布页' })
    expect(urlButton).toHaveAttribute('data-testid', 'site-url-prj-site-1')
    expect(screen.getByTestId('site-publish-prj-site-1')).toHaveClass('h-11', 'md:h-8')
    expect(screen.getByTestId('site-more-prj-site-1')).toHaveClass(
      'h-11',
      'w-11',
      'md:h-8',
      'md:w-8'
    )
    await userEvent.click(urlButton)
    expect(openExternalUrl).toHaveBeenCalledWith('http://sites.internal/product')
  })

  test('labels the project network column as network access', async () => {
    render(<SitesWorkspace api={createApi()} onCreate={vi.fn()} />)

    await screen.findByTestId('site-row-prj-site-1')
    expect(screen.getByText('网络访问')).toBeInTheDocument()
  })

  test('retries a failed thumbnail when the same project receives a new snapshot', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)

    const row = await screen.findByTestId('site-row-prj-site-1')
    fireEvent.error(row.querySelector('img')!)
    expect(row.querySelector('img')).not.toBeInTheDocument()

    vi.mocked(api.listSites).mockResolvedValueOnce({
      items: [
        {
          ...innerProject,
          snapshot: 'https://snapshots.example.site/product-v2.png',
        },
      ],
      next_cursor: null,
    })
    await userEvent.click(screen.getByTestId('sites-refresh-button'))

    await waitFor(() =>
      expect(row.querySelector('img')).toHaveAttribute(
        'src',
        'https://snapshots.example.site/product-v2.png'
      )
    )
  })

  test('debounces search and resets the cursor before replacing current results', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    fireEvent.change(screen.getByTestId('sites-search-input'), {
      target: { value: '机器人' },
    })

    await waitFor(() => {
      expect(api.listSites).toHaveBeenLastCalledWith({
        q: '机器人',
        cursor: null,
        limit: 20,
      })
    })
  })

  test('does not load an old cursor while a new search first page is pending', async () => {
    const api = createApi()
    const searchRequest = deferred<SiteListResponse>()
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [innerProject], next_cursor: 'old-query-cursor' })
      .mockImplementationOnce(() => searchRequest.promise)
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    fireEvent.change(screen.getByTestId('sites-search-input'), {
      target: { value: '新查询' },
    })
    await waitFor(() => {
      expect(api.listSites).toHaveBeenLastCalledWith({
        q: '新查询',
        cursor: null,
        limit: 20,
      })
    })

    const loadMoreButton = screen.getByTestId('sites-load-more-button')
    expect(loadMoreButton).toBeDisabled()
    fireEvent.click(loadMoreButton)
    await act(async () => {
      searchRequest.resolve({ items: [], next_cursor: null })
    })

    expect(api.listSites).toHaveBeenCalledTimes(2)
    expect(api.listSites).not.toHaveBeenCalledWith({
      q: '新查询',
      cursor: 'old-query-cursor',
      limit: 20,
    })
  })

  test('does not expose an old cursor after a new search first page fails', async () => {
    const api = createApi()
    vi.mocked(api.listSites).mockImplementation(({ q }) => {
      if (q === '失败查询') return Promise.reject(new Error('新查询加载失败'))
      return Promise.resolve({ items: [innerProject], next_cursor: 'old-query-cursor' })
    })
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    fireEvent.change(screen.getByTestId('sites-search-input'), {
      target: { value: '失败查询' },
    })
    await waitFor(() => {
      expect(api.listSites).toHaveBeenLastCalledWith({
        q: '失败查询',
        cursor: null,
        limit: 20,
      })
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('新查询加载失败')

    const loadMoreButton = screen.getByTestId('sites-load-more-button')
    expect(loadMoreButton).toBeDisabled()
    fireEvent.click(loadMoreButton)

    expect(api.listSites).toHaveBeenCalledTimes(2)
    expect(api.listSites).not.toHaveBeenCalledWith({
      q: '失败查询',
      cursor: 'old-query-cursor',
      limit: 20,
    })
  })

  test('publishes an inner project by replacing it with the returned outer project', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-publish-prj-site-1'))

    await waitFor(() => expect(api.publishSite).toHaveBeenCalledWith('prj-site-1'))
    const externalUrl = await screen.findByRole('button', {
      name: '打开外部站点 产品发布页',
    })
    expect(externalUrl).toHaveAttribute('data-testid', 'site-url-prj-site-1')
    expect(externalUrl).toHaveTextContent('https://product.example.site')
    expect(screen.getByTestId('site-published-prj-site-1')).toHaveTextContent('已发布')
    expect(screen.queryByTestId('site-publish-prj-site-1')).not.toBeInTheDocument()

    await userEvent.click(externalUrl)
    expect(openExternalUrl).toHaveBeenLastCalledWith('https://product.example.site')
  })

  test('keeps a failed publish retryable and preserves the inner project row', async () => {
    const api = createApi()
    const publishRequest = deferred<SiteProject>()
    vi.mocked(api.publishSite).mockImplementationOnce(() => publishRequest.promise)
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-publish-prj-site-1'))
    expect(screen.getByTestId('site-publish-prj-site-1')).toBeDisabled()
    expect(screen.getByTestId('site-more-prj-site-1')).toBeDisabled()

    await act(async () => {
      publishRequest.reject(new Error('发布网关不可用'))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('发布网关不可用')
    expect(screen.getByTestId('site-row-prj-site-1')).toBeInTheDocument()
    expect(screen.getByTestId('site-publish-prj-site-1')).toBeEnabled()
    expect(screen.getByTestId('site-more-prj-site-1')).toBeEnabled()
    expect(screen.getByTestId('site-url-prj-site-1')).toHaveTextContent(
      'http://sites.internal/product'
    )
  })

  test('keeps a successful publish authoritative over an older refresh response', async () => {
    const api = createApi()
    const refreshRequest = deferred<SiteListResponse>()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    vi.mocked(api.listSites).mockImplementationOnce(() => refreshRequest.promise)

    await userEvent.click(screen.getByTestId('sites-refresh-button'))
    await userEvent.click(screen.getByTestId('site-publish-prj-site-1'))
    expect(await screen.findByTestId('site-published-prj-site-1')).toBeInTheDocument()

    await act(async () => {
      refreshRequest.resolve({ items: [innerProject], next_cursor: null })
    })

    expect(screen.getByTestId('site-published-prj-site-1')).toBeInTheDocument()
    expect(screen.getByTestId('site-url-prj-site-1')).toHaveTextContent(
      'https://product.example.site'
    )
    expect(screen.queryByTestId('site-publish-prj-site-1')).not.toBeInTheDocument()
  })

  test('clears a publish error when a refresh returns the project as outer', async () => {
    const api = createApi()
    vi.mocked(api.publishSite).mockRejectedValueOnce(new Error('发布暂时失败'))
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-publish-prj-site-1'))
    expect(await screen.findByRole('alert')).toHaveTextContent('发布暂时失败')
    vi.mocked(api.listSites).mockResolvedValueOnce({ items: [outerProject], next_cursor: null })

    await userEvent.click(screen.getByTestId('sites-refresh-button'))

    expect(await screen.findByTestId('site-published-prj-site-1')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('clears a missing project publish error before a later cursor page restores the row', async () => {
    const api = createApi()
    vi.mocked(api.publishSite).mockRejectedValueOnce(new Error('旧发布错误'))
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-publish-prj-site-1'))
    expect(await screen.findByRole('alert')).toHaveTextContent('旧发布错误')
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [], next_cursor: 'cursor-after-empty' })
      .mockResolvedValueOnce({ items: [innerProject], next_cursor: null })

    await userEvent.click(screen.getByTestId('sites-refresh-button'))
    await screen.findByText('还没有站点')
    await userEvent.click(screen.getByTestId('sites-load-more-button'))

    expect(await screen.findByTestId('site-row-prj-site-1')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('prevents a publish and delete menu action from starting for the same project', async () => {
    const api = createApi()
    const publishRequest = deferred<SiteProject>()
    vi.mocked(api.publishSite).mockImplementationOnce(() => publishRequest.promise)
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    const publishButton = screen.getByTestId('site-publish-prj-site-1')
    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    const deleteMenuItem = screen.getByTestId('site-delete-menu-item-prj-site-1')
    act(() => {
      fireEvent.click(publishButton)
      fireEvent.click(deleteMenuItem)
    })

    expect(api.publishSite).toHaveBeenCalledTimes(1)
    expect(api.deleteSite).not.toHaveBeenCalled()
    expect(screen.queryByTestId('site-delete-dialog')).not.toBeInTheDocument()

    await act(async () => {
      publishRequest.resolve(outerProject)
    })
  })

  test('opens rename before delete with the current title and native length validation', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    const renameItem = screen.getByTestId('site-rename-menu-item-prj-site-1')
    const deleteItem = screen.getByTestId('site-delete-menu-item-prj-site-1')
    expect(renameItem.compareDocumentPosition(deleteItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    await userEvent.click(renameItem)

    const input = screen.getByTestId('site-rename-input')
    expect(input).toHaveValue('产品发布页')
    expect(input).toHaveAttribute('maxlength', '255')
    expect(screen.getByTestId('site-rename-confirm-button')).toBeEnabled()
    expect(screen.getByTestId('site-publish-prj-site-1')).toBeDisabled()
    expect(screen.getByTestId('site-more-prj-site-1')).toBeDisabled()

    await userEvent.clear(input)
    expect(screen.getByTestId('site-rename-confirm-button')).toBeDisabled()
  })

  test('keeps the row menu trigger connected and restores focus after cancelling rename', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    const menuTrigger = screen.getByTestId('site-more-prj-site-1')
    menuTrigger.focus()
    expect(menuTrigger).toHaveFocus()
    await userEvent.click(menuTrigger)
    await userEvent.click(screen.getByTestId('site-rename-menu-item-prj-site-1'))

    expect(menuTrigger.isConnected).toBe(true)
    expect(screen.getByTestId('site-more-prj-site-1')).toBe(menuTrigger)
    expect(menuTrigger).toBeDisabled()
    fireEvent.click(menuTrigger)
    expect(screen.queryByTestId('site-more-prj-site-1-menu')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('site-rename-input-cancel-button'))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(menuTrigger.isConnected).toBe(true)
    expect(screen.getByTestId('site-more-prj-site-1')).toBe(menuTrigger)
    expect(menuTrigger).toHaveFocus()
  })

  test('trims a rename and replaces the row with the complete project returned by the service', async () => {
    const renamedProject: SiteProject = {
      ...outerProject,
      title: '新版产品站',
      url: 'https://renamed.example.site',
      snapshot: 'https://snapshots.example.site/renamed.png',
    }
    const api = createApi()
    vi.mocked(api.publishSite).mockRejectedValueOnce(new Error('旧发布错误'))
    vi.mocked(api.renameSite).mockResolvedValueOnce(renamedProject)
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-publish-prj-site-1'))
    expect(await screen.findByRole('alert')).toHaveTextContent('旧发布错误')
    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-rename-menu-item-prj-site-1'))
    const input = screen.getByTestId('site-rename-input')
    await userEvent.clear(input)
    await userEvent.type(input, '  新版产品站  ')
    await userEvent.click(screen.getByTestId('site-rename-confirm-button'))

    await waitFor(() => expect(api.renameSite).toHaveBeenCalledWith('prj-site-1', '新版产品站'))
    expect(await screen.findByText('新版产品站')).toBeInTheDocument()
    expect(screen.getByTestId('site-url-prj-site-1')).toHaveTextContent(
      'https://renamed.example.site'
    )
    expect(screen.getByTestId('site-published-prj-site-1')).toBeInTheDocument()
    expect(screen.queryByTestId('site-publish-prj-site-1')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('keeps a failed rename editable and open so the same value can be retried', async () => {
    const renamedProject = { ...innerProject, title: '可重试名称' }
    const api = createApi()
    vi.mocked(api.renameSite)
      .mockRejectedValueOnce(new Error('名称已存在'))
      .mockResolvedValueOnce(renamedProject)
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-rename-menu-item-prj-site-1'))
    const input = screen.getByTestId('site-rename-input')
    await userEvent.clear(input)
    await userEvent.type(input, '可重试名称')
    await userEvent.click(screen.getByTestId('site-rename-confirm-button'))

    expect(await screen.findByRole('alert')).toHaveTextContent('名称已存在')
    expect(input).toHaveValue('可重试名称')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('site-rename-confirm-button')).toBeEnabled()

    await userEvent.click(screen.getByTestId('site-rename-confirm-button'))
    await waitFor(() => expect(api.renameSite).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('可重试名称')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('blocks duplicate submission, dismissal, publish, and menu actions while rename is pending', async () => {
    const renameRequest = deferred<SiteProject>()
    const renamedProject = { ...innerProject, title: '等待完成的名称' }
    const api = createApi()
    vi.mocked(api.renameSite).mockImplementationOnce(() => renameRequest.promise)
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-rename-menu-item-prj-site-1'))
    const input = screen.getByTestId('site-rename-input')
    await userEvent.clear(input)
    await userEvent.type(input, '等待完成的名称')
    const confirmButton = screen.getByTestId('site-rename-confirm-button')
    act(() => {
      fireEvent.click(confirmButton)
      fireEvent.click(confirmButton)
    })

    expect(api.renameSite).toHaveBeenCalledTimes(1)
    expect(input).toBeDisabled()
    expect(screen.getByTestId('site-rename-input-close-button')).toBeDisabled()
    expect(screen.getByTestId('site-rename-input-cancel-button')).toBeDisabled()
    expect(confirmButton).toBeDisabled()
    expect(screen.getByTestId('site-publish-prj-site-1')).toBeDisabled()
    expect(screen.getByTestId('site-more-prj-site-1')).toBeDisabled()

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('site-rename-input-overlay'))
    fireEvent.click(screen.getByTestId('site-publish-prj-site-1'))
    fireEvent.click(screen.getByTestId('site-more-prj-site-1'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(api.publishSite).not.toHaveBeenCalled()
    expect(api.deleteSite).not.toHaveBeenCalled()

    await act(async () => {
      renameRequest.resolve(renamedProject)
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test('uses synchronous guards when rename races publish and delete in the same tick', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    const publishButton = screen.getByTestId('site-publish-prj-site-1')
    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    const renameItem = screen.getByTestId('site-rename-menu-item-prj-site-1')
    const deleteItem = screen.getByTestId('site-delete-menu-item-prj-site-1')
    act(() => {
      fireEvent.click(renameItem)
      fireEvent.click(publishButton)
      fireEvent.click(deleteItem)
    })

    expect(screen.getByTestId('site-rename-input')).toBeInTheDocument()
    expect(screen.queryByTestId('site-delete-dialog')).not.toBeInTheDocument()
    expect(api.publishSite).not.toHaveBeenCalled()
    expect(api.deleteSite).not.toHaveBeenCalled()
  })

  test('keeps a successful rename authoritative over an older refresh response', async () => {
    const api = createApi()
    const refreshRequest = deferred<SiteListResponse>()
    const renamedProject: SiteProject = {
      ...innerProject,
      title: '刷新期间重命名',
      url: 'http://sites.internal/renamed-during-refresh',
    }
    vi.mocked(api.renameSite).mockResolvedValueOnce(renamedProject)
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    vi.mocked(api.listSites).mockImplementationOnce(() => refreshRequest.promise)

    await userEvent.click(screen.getByTestId('sites-refresh-button'))
    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-rename-menu-item-prj-site-1'))
    const input = screen.getByTestId('site-rename-input')
    await userEvent.clear(input)
    await userEvent.type(input, '刷新期间重命名')
    await userEvent.click(screen.getByTestId('site-rename-confirm-button'))
    expect(await screen.findByText('刷新期间重命名')).toBeInTheDocument()

    await act(async () => {
      refreshRequest.resolve({ items: [innerProject], next_cursor: null })
    })

    expect(screen.getByText('刷新期间重命名')).toBeInTheDocument()
    expect(screen.queryByText('产品发布页')).not.toBeInTheDocument()
    expect(screen.getByTestId('site-url-prj-site-1')).toHaveTextContent(
      'http://sites.internal/renamed-during-refresh'
    )
  })

  test('appends a cursor page, ignores duplicate ids, and hides load more at the end', async () => {
    const secondProject: SiteProject = {
      ...innerProject,
      id: 'prj-site-2',
      title: '机器人学习站',
      url: 'http://sites.internal/robot',
    }
    const api = createApi()
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [innerProject], next_cursor: 'cursor-page-2' })
      .mockResolvedValueOnce({
        items: [{ ...innerProject, title: '重复项目' }, secondProject],
        next_cursor: null,
      })

    render(<SitesWorkspace api={api} onCreate={vi.fn()} pageSize={1} />)
    await screen.findByText('产品发布页')
    await userEvent.click(screen.getByTestId('sites-load-more-button'))

    expect(await screen.findByText('机器人学习站')).toBeInTheDocument()
    expect(screen.getByText('产品发布页')).toBeInTheDocument()
    expect(screen.queryByText('重复项目')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('site-row-prj-site-1')).toHaveLength(1)
    expect(api.listSites).toHaveBeenLastCalledWith({
      q: '',
      cursor: 'cursor-page-2',
      limit: 1,
    })
    expect(screen.queryByTestId('sites-load-more-button')).not.toBeInTheDocument()
  })

  test('ignores an older cursor page after a new search succeeds', async () => {
    const stalePageRequest = deferred<SiteListResponse>()
    const searchProject: SiteProject = {
      ...innerProject,
      id: 'prj-search-current',
      title: '当前搜索站点',
    }
    const staleProject: SiteProject = {
      ...innerProject,
      id: 'prj-stale-page',
      title: '过期分页站点',
    }
    const api = createApi()
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [innerProject], next_cursor: 'old-cursor' })
      .mockImplementationOnce(() => stalePageRequest.promise)
      .mockResolvedValueOnce({ items: [searchProject], next_cursor: null })

    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    await userEvent.click(screen.getByTestId('sites-load-more-button'))
    fireEvent.change(screen.getByTestId('sites-search-input'), {
      target: { value: '当前搜索' },
    })
    expect(await screen.findByText('当前搜索站点')).toBeInTheDocument()

    await act(async () => {
      stalePageRequest.resolve({
        items: [staleProject],
        next_cursor: 'stale-next-cursor',
      })
    })

    expect(screen.queryByText('过期分页站点')).not.toBeInTheDocument()
    expect(screen.getByTestId('site-row-prj-search-current')).toBeInTheDocument()
    expect(screen.queryByTestId('sites-load-more-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sites-unavailable-state')).not.toBeInTheDocument()
  })

  test('ignores an unavailable error from a stale cursor page after search succeeds', async () => {
    const stalePageRequest = deferred<SiteListResponse>()
    const searchProject: SiteProject = {
      ...innerProject,
      id: 'prj-search-current',
      title: '当前搜索站点',
    }
    const api = createApi()
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [innerProject], next_cursor: 'old-cursor' })
      .mockImplementationOnce(() => stalePageRequest.promise)
      .mockResolvedValueOnce({ items: [searchProject], next_cursor: null })

    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    await userEvent.click(screen.getByTestId('sites-load-more-button'))
    fireEvent.change(screen.getByTestId('sites-search-input'), {
      target: { value: '当前搜索' },
    })
    expect(await screen.findByText('当前搜索站点')).toBeInTheDocument()

    await act(async () => {
      stalePageRequest.reject(
        new ApiError('Sites is not available yet', 503, 'sites_not_available')
      )
    })

    expect(screen.getByTestId('site-row-prj-search-current')).toBeInTheDocument()
    expect(screen.queryByTestId('sites-unavailable-state')).not.toBeInTheDocument()
  })

  test('does not restore a deleted project from an overlapping cursor response', async () => {
    const pageRequest = deferred<SiteListResponse>()
    const secondProject: SiteProject = {
      ...innerProject,
      id: 'prj-site-2',
      title: '分页新站点',
    }
    const api = createApi()
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [innerProject], next_cursor: 'cursor-page-2' })
      .mockImplementationOnce(() => pageRequest.promise)

    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    await userEvent.click(screen.getByTestId('sites-load-more-button'))
    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-menu-item-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-confirm-button'))
    await waitFor(() => expect(screen.queryByTestId('site-row-prj-site-1')).not.toBeInTheDocument())

    await act(async () => {
      pageRequest.resolve({ items: [innerProject, secondProject], next_cursor: null })
    })

    expect(screen.queryByTestId('site-row-prj-site-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('site-row-prj-site-2')).toBeInTheDocument()
  })

  test('keeps rows after a load-more failure and starts a new search from a null cursor', async () => {
    const searchProject: SiteProject = {
      ...innerProject,
      id: 'prj-search-1',
      title: '机器人站点',
      url: 'http://sites.internal/search-result',
    }
    const api = createApi()
    vi.mocked(api.listSites)
      .mockResolvedValueOnce({ items: [innerProject], next_cursor: 'cursor-page-2' })
      .mockRejectedValueOnce(new Error('下一页加载失败'))
      .mockResolvedValueOnce({ items: [searchProject], next_cursor: null })

    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    await userEvent.click(screen.getByTestId('sites-load-more-button'))

    expect(await screen.findByRole('alert')).toHaveTextContent('下一页加载失败')
    expect(screen.getByTestId('site-row-prj-site-1')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('sites-search-input'), {
      target: { value: '机器人' },
    })
    await waitFor(() => {
      expect(api.listSites).toHaveBeenLastCalledWith({
        q: '机器人',
        cursor: null,
        limit: 20,
      })
    })
    expect(await screen.findByText('机器人站点')).toBeInTheDocument()
  })

  test('keeps current rows and cursor available when a refresh fails', async () => {
    const api = createApi([innerProject], 'cursor-page-2')
    const refreshRequest = deferred<SiteListResponse>()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')
    vi.mocked(api.listSites).mockImplementationOnce(() => refreshRequest.promise)

    await userEvent.click(screen.getByTestId('sites-refresh-button'))

    expect(screen.getByTestId('site-row-prj-site-1')).toBeInTheDocument()
    expect(screen.queryByLabelText('正在加载站点')).not.toBeInTheDocument()
    expect(api.listSites).toHaveBeenLastCalledWith({ q: '', cursor: null, limit: 20 })
    expect(screen.getByTestId('sites-load-more-button')).toBeDisabled()

    await act(async () => {
      refreshRequest.reject(new Error('刷新失败'))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败')
    expect(screen.getByTestId('site-row-prj-site-1')).toBeInTheDocument()
    expect(screen.getByTestId('sites-load-more-button')).toBeEnabled()

    vi.mocked(api.listSites).mockResolvedValueOnce({ items: [], next_cursor: null })
    await userEvent.click(screen.getByTestId('sites-load-more-button'))
    expect(api.listSites).toHaveBeenLastCalledWith({
      q: '',
      cursor: 'cursor-page-2',
      limit: 20,
    })
  })

  test('invokes the create entry from the page header', async () => {
    const onCreate = vi.fn()
    render(<SitesWorkspace api={createApi([])} onCreate={onCreate} />)
    await screen.findByText('还没有站点')

    await userEvent.click(screen.getByTestId('sites-create-button'))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  test('requires confirmation and explains that local files are preserved', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-menu-item-prj-site-1'))

    expect(api.deleteSite).not.toHaveBeenCalled()
    expect(screen.getByTestId('site-delete-dialog')).toHaveTextContent('产品发布页')
    expect(screen.getByTestId('site-delete-dialog')).toHaveTextContent(
      '存在关联资源时服务会拒绝删除'
    )
    expect(screen.getByTestId('site-delete-dialog')).toHaveTextContent('不会删除本地目录')
    expect(screen.getByTestId('site-publish-prj-site-1')).toBeDisabled()
    expect(screen.getByTestId('site-more-prj-site-1')).toBeDisabled()
    fireEvent.click(screen.getByTestId('site-publish-prj-site-1'))
    expect(api.publishSite).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('site-delete-cancel-button'))
    expect(screen.queryByTestId('site-delete-dialog')).not.toBeInTheDocument()
    expect(api.deleteSite).not.toHaveBeenCalled()
  })

  test('traps dialog focus and restores it to the row menu trigger on escape', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-menu-item-prj-site-1'))

    const cancelButton = screen.getByTestId('site-delete-cancel-button')
    const confirmButton = screen.getByTestId('site-delete-confirm-button')
    expect(cancelButton).toHaveFocus()
    expect(cancelButton).toHaveClass('h-11', 'md:h-8')
    expect(confirmButton).toHaveClass('h-11', 'md:h-8')

    await userEvent.tab({ shift: true })
    expect(confirmButton).toHaveFocus()
    await userEvent.tab()
    expect(cancelButton).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('site-delete-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('site-more-prj-site-1')).toHaveFocus()
  })

  test('keeps a deleting dialog open and blocks row actions until deletion completes', async () => {
    const api = createApi()
    const deleteRequest = deferred<void>()
    vi.mocked(api.deleteSite).mockImplementationOnce(() => deleteRequest.promise)
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-menu-item-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-confirm-button'))
    await waitFor(() => expect(api.deleteSite).toHaveBeenCalledWith('prj-site-1'))

    expect(screen.getByTestId('site-delete-cancel-button')).toBeDisabled()
    expect(screen.getByTestId('site-delete-confirm-button')).toBeDisabled()
    expect(screen.getByTestId('site-publish-prj-site-1')).toBeDisabled()
    expect(screen.getByTestId('site-more-prj-site-1')).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('site-delete-dialog-overlay'))
    expect(screen.getByTestId('site-delete-dialog')).toBeInTheDocument()

    await act(async () => {
      deleteRequest.resolve(undefined)
    })
    expect(screen.queryByTestId('site-row-prj-site-1')).not.toBeInTheDocument()
  })

  test('removes only the confirmed project after the API succeeds', async () => {
    const api = createApi()
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-menu-item-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-confirm-button'))

    await waitFor(() => expect(api.deleteSite).toHaveBeenCalledWith('prj-site-1'))
    await waitFor(() => expect(screen.queryByTestId('site-row-prj-site-1')).not.toBeInTheDocument())
  })

  test('keeps the row and dialog open when deletion fails so it can be retried', async () => {
    const api = createApi()
    vi.mocked(api.deleteSite).mockRejectedValueOnce(new Error('公网撤销失败'))
    render(<SitesWorkspace api={api} onCreate={vi.fn()} />)
    await screen.findByText('产品发布页')

    await userEvent.click(screen.getByTestId('site-more-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-menu-item-prj-site-1'))
    await userEvent.click(screen.getByTestId('site-delete-confirm-button'))

    expect(await screen.findByRole('alert')).toHaveTextContent('公网撤销失败')
    expect(screen.getByTestId('site-row-prj-site-1')).toBeInTheDocument()
    expect(screen.getByTestId('site-delete-dialog')).toBeInTheDocument()
  })
})
