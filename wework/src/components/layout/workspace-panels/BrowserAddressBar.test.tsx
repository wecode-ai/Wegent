import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { browserAddressAction, hasInvalidBrowserPort, normalizeBrowserUrl } from '@/lib/browser-url'
import {
  searchEmbeddedBrowserHistory,
  type EmbeddedBrowserHistoryEntry,
} from '@/lib/embedded-browser-history'
import { BrowserAddressBar } from './BrowserAddressBar'

vi.mock('@/lib/embedded-browser-history', () => ({ searchEmbeddedBrowserHistory: vi.fn() }))

function renderAddress(historyAvailable: boolean) {
  const navigate = vi.fn()
  function Address() {
    const [address, setAddress] = useState('')
    return (
      <BrowserAddressBar
        active
        historyAvailable={historyAvailable}
        address={address}
        inputRef={null}
        onChange={setAddress}
        onNavigate={navigate}
        onFocus={() => {}}
        onBlur={() => {}}
      />
    )
  }
  render(<Address />)
  return { navigate, input: screen.getByTestId('workspace-browser-url-input') }
}

test('discards an older history response and navigates once to the keyboard-selected result', async () => {
  const entry = (url: string): EmbeddedBrowserHistoryEntry => ({
    url,
    title: url,
    id: url,
    visitTimeMs: 1,
  })
  const stale = Promise.withResolvers<EmbeddedBrowserHistoryEntry[]>()
  vi.mocked(searchEmbeddedBrowserHistory)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce([entry('https://docs.test/latest')])
  const { navigate, input } = renderAddress(true)
  await userEvent.click(input)
  fireEvent.input(input, { target: { value: 'old' } })
  await waitFor(() => expect(searchEmbeddedBrowserHistory).toHaveBeenCalledTimes(1))
  fireEvent.input(input, { target: { value: 'latest' } })
  const option = await screen.findByTestId('workspace-browser-address-history-option')
  await act(async () => stale.resolve([entry('https://docs.test/old')]))
  expect(screen.getAllByTestId('workspace-browser-address-history-option')).toEqual([option])
  expect(screen.getByTestId('workspace-browser-address-submit')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await userEvent.keyboard('{ArrowDown}{Enter}')
  expect(navigate).toHaveBeenCalledExactlyOnceWith('https://docs.test/latest')
})

test.each(['pointer', 'keyboard'])('retries an unavailable history lookup by %s', async method => {
  const history = vi.mocked(searchEmbeddedBrowserHistory)
  history.mockClear()
  history
    .mockRejectedValueOnce(new Error('History is unavailable'))
    .mockResolvedValueOnce([
      { id: 'previous', url: 'https://docs.test/guide', title: 'Guide', visitTimeMs: 1 },
    ])
  const { navigate, input } = renderAddress(true)
  await userEvent.click(input)
  fireEvent.input(input, { target: { value: 'docs.test' } })
  const retry = await screen.findByTestId('workspace-browser-address-history-retry')
  if (method === 'pointer') await userEvent.click(retry)
  else await userEvent.keyboard('{ArrowDown}{Enter}')
  expect(navigate).not.toHaveBeenCalled()
  expect(input).toHaveValue('docs.test')
  expect(await screen.findByTestId('workspace-browser-address-history-option')).toHaveTextContent(
    'Guide'
  )
  expect(history.mock.calls.map(([text]) => text)).toEqual(['docs.test', 'docs.test'])
  await userEvent.click(screen.getByTestId('workspace-browser-address-submit'))
  expect(navigate).toHaveBeenCalledExactlyOnceWith('http://docs.test/')
})

test('keeps a single-label host reachable and submits search text only after confirmation', async () => {
  const { navigate, input } = renderAddress(false)
  await userEvent.click(input)
  fireEvent.input(input, { target: { value: 'intranet' } })
  await userEvent.click(screen.getByTestId('workspace-browser-address-host-option'))
  expect(navigate).toHaveBeenCalledExactlyOnceWith('http://intranet/')
  fireEvent.input(input, { target: { value: '中文 & a+b' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(navigate).toHaveBeenCalledTimes(1)
  await userEvent.keyboard('{Enter}')
  expect(navigate.mock.calls.map(([url]) => url)).toEqual([
    'http://intranet/',
    'https://www.google.com/search?q=%E4%B8%AD%E6%96%87+%26+a%2Bb',
  ])
})

test.each([
  'site:example.com 视频设置',
  'site:example.com',
  'error: timeout',
  '10.0.0.5 setup',
  'read docs.test/guide',
  '2026',
  '404',
  'why?',
  'c#',
  'react@19',
  'react@19.2.0',
])('submits %s as the complete search query when Enter is pressed', async query => {
  const { input, navigate } = renderAddress(false)
  await userEvent.click(input)
  fireEvent.input(input, { target: { value: query } })
  await userEvent.keyboard('{Enter}')
  expect(navigate).toHaveBeenCalledTimes(1)
  const [url] = navigate.mock.calls[0]
  expect(normalizeBrowserUrl(url)).toBe(url)
  const target = new URL(url)
  expect(target.origin + target.pathname).toBe('https://www.google.com/search')
  expect(target.searchParams.get('q')).toBe(query)
})

test.each([
  ['https://example.test/a b', 'https://example.test/a%20b'],
  ['localhost:8080/path', 'http://localhost:8080/path'],
  ['site:8080/guide', 'http://site:8080/guide'],
  ['3d:8080/report', 'http://3d:8080/report'],
  ['intranet/reports', 'http://intranet/reports'],
  ['intranet?token=sample', 'http://intranet/?token=sample'],
  ['reader@10.0.0.5', 'http://reader@10.0.0.5/'],
  ['reader:sample@intranet.test/report', 'http://reader:sample@intranet.test/report'],
  ['http://2026', 'http://0.0.7.234/'],
  ['2001:db8::1/path', null],
  ['/tmp/video settings', 'file:///tmp/video%20settings'],
  ['ftp://example.test/a b', null],
  ['custom:open', null],
  ['javascript: alert(1)', null],
  ['tel:1234', null],
  ['mailto:demo@example.test', null],
] as const)('keeps %s on the address navigation path', (input, expected) => {
  const action = browserAddressAction(input)
  expect(action.kind).toBe('visit')
  expect(normalizeBrowserUrl(action.url)).toBe(expected)
})

test.each([
  ['10.0.0.5:84443/reports?token=sample', true],
  ['10.0.0.5 :84443/reports?token=sample', true],
  ['10.0.0.999', false],
  ['10.0.0.999/reports?token=sample', false],
  ['10.0..5/reports?token=sample', false],
  ['https ://intranet.test/reports?token=sample', false],
  ['https: //intranet.test/reports?token=sample', false],
  ['https://intra%20net.test/reports?token=sample', false],
  ['intra net.test/reports?token=sample', false],
  ['intra%20net.test/reports?token=sample', false],
  ['intranet .test:8080/#/reports?token=sample', false],
  ['[fd00::zz]/reports?token=sample', false],
  ['[fd00::1]:65536/reports', true],
  ['10.0.0.5:oops/reports', true],
  ['3d.intra.test:bad/reports?token=sample', true],
  ['3d:bad/report?token=sample', true],
  ['3d.intra.test /reports?token=sample', false],
  ['reader@10.0.0.5:84443/report', true],
] as const)(
  'keeps the invalid endpoint %s out of the search query on Enter',
  async (address, invalidPort) => {
    const { input, navigate } = renderAddress(false)
    await userEvent.click(input)
    fireEvent.input(input, { target: { value: address } })
    await userEvent.keyboard('{Enter}')
    expect(navigate).toHaveBeenCalledExactlyOnceWith(address)
    expect(normalizeBrowserUrl(address)).toBeNull()
    expect(hasInvalidBrowserPort(address)).toBe(invalidPort)
  }
)
