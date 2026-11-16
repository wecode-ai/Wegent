import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CloudFilePreviewDialog } from './CloudFilePreviewDialog'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}))

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn().mockReturnValue('blob:issue-preview')
      static revokeObjectURL = vi.fn()
    }
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const props = {
  filename: 'notes.txt',
  contentType: 'text/plain',
  onClose: vi.fn(),
  onDownload: vi.fn(),
}
const textBlob = (text: string) =>
  Object.assign(new Blob([text], { type: 'text/plain' }), { text: async () => text })

it('shows read failures instead of keeping the loading screen and recovers on explicit retry', async () => {
  const loadFile = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(textBlob('Recovered attachment'))
  const view = render(<CloudFilePreviewDialog {...props} loadFile={loadFile} />)
  const retry = await screen.findByTestId('cloud-file-preview-retry')
  expect(loadFile).toHaveBeenCalledTimes(1)
  fireEvent.click(retry)
  await waitFor(() =>
    expect(screen.getByTestId('cloud-file-preview-text')).toHaveTextContent('Recovered attachment')
  )
  expect(loadFile).toHaveBeenCalledTimes(2)
  view.rerender(
    <CloudFilePreviewDialog {...props} sizeLabel="Updated metadata" loadFile={loadFile} />
  )
  expect(loadFile).toHaveBeenCalledTimes(2)
})

it('decodes generic image downloads using the shared MIME registry', async () => {
  render(
    <CloudFilePreviewDialog
      {...props}
      filename="chart.png"
      contentType="application/octet-stream"
      loadFile={vi.fn().mockResolvedValue(new Blob(['png'], { type: 'application/octet-stream' }))}
    />
  )
  const image = await screen.findByTestId('cloud-file-preview-image')
  expect(image).toHaveAttribute('src', 'blob:issue-preview')
  expect(vi.mocked(URL.createObjectURL).mock.calls[0][0].type).toBe('image/png')
  fireEvent.error(image)
  expect(screen.getByTestId('cloud-file-preview-retry')).toBeInTheDocument()
})

it('does not load an HTML response into the PDF frame based on its filename', async () => {
  render(
    <CloudFilePreviewDialog
      {...props}
      filename="report.pdf"
      contentType="application/pdf"
      loadFile={vi
        .fn()
        .mockResolvedValue(new Blob(['<script>bad()</script>'], { type: 'text/html' }))}
    />
  )
  await screen.findByTestId('cloud-file-preview-unsupported')
  expect(screen.queryByTestId('cloud-file-preview-pdf')).not.toBeInTheDocument()
  expect(document.querySelector('script, iframe')).toBeNull()
})

it('keeps a readable preview when download fails and clears the download error after recovery', async () => {
  const onDownload = vi
    .fn()
    .mockRejectedValueOnce(new Error('download unavailable'))
    .mockResolvedValue(undefined)
  render(
    <CloudFilePreviewDialog
      {...props}
      loadFile={vi.fn().mockResolvedValue(textBlob('Readable preview'))}
      onDownload={onDownload}
    />
  )
  await screen.findByTestId('cloud-file-preview-text')
  fireEvent.click(screen.getByTestId('cloud-file-preview-download'))
  expect(await screen.findByTestId('cloud-file-preview-download-error')).toHaveTextContent(
    'download unavailable'
  )
  expect(screen.getByTestId('cloud-file-preview-text')).toHaveTextContent('Readable preview')
  fireEvent.click(screen.getByTestId('cloud-file-preview-download'))
  await waitFor(() =>
    expect(screen.queryByTestId('cloud-file-preview-download-error')).not.toBeInTheDocument()
  )
  expect(onDownload).toHaveBeenCalledTimes(2)
})
