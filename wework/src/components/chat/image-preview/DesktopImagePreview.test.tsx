import i18n from '@/i18n'
import { useImageEditSubmission } from '@/components/layout/useImageEditSubmission'
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { resolvePreparingAttachments } from '@/lib/runtime-attachments'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { openLocalFile, revealLocalFile } from '@/lib/local-terminal'
import * as electronFiles from '@/lib/electron-local-file'
import * as runtimeEnvironment from '@/lib/runtime-environment'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopImagePreview } from './DesktopImagePreview'
import { ImageEditContext } from './ImageEditContext'
import { composeImageMarkupMessage } from './imageEdit'
import { markupSurfaceSize, strokeGeometry } from './imageMarkup'
import { useAttachmentImageServices } from '../useAttachmentImageServices'

afterEach(() => vi.unstubAllGlobals())

test('uses the same isotropic coordinates for the preview and the exported pen outline', () => {
  expect(markupSurfaceSize({ width: 1200, height: 400 })).toEqual({
    width: 100,
    height: 400 / 12,
    scale: 12,
  })
  const geometry = strokeGeometry({
    width: 2,
    points: [
      { x: 10, y: 10, pressure: 0 },
      { x: 20, y: 10, pressure: 1 },
    ],
  })
  expect(geometry.filled).toBe(true)
  expect(geometry.path).toContain('M 10 10.42 L 20 11 L 20 9 L 10 9.58')
})

test('numbers marked images in attachment order and consumes coordinates once', async () => {
  const previousLanguage = i18n.language
  await i18n.changeLanguage('zh-CN')
  try {
    const image = {
      id: 1,
      filename: 'first.png',
      file_size: 3,
      mime_type: 'image/png',
      file_extension: '.png',
      created_at: '',
      status: 'ready' as const,
    }
    const message = composeImageMarkupMessage('目标正文', [
      image,
      { ...image, id: 2, mime_type: 'text/plain', file_extension: '.txt' },
      { ...image, id: 3, image_markup_comments: [{ x: 36.7, y: 50.4, text: '第二张' }] },
      { ...image, id: 4, image_markup_comments: [{ x: 60, y: 30, text: '第三张' }] },
    ])
    expect(message.content).toBe(
      '目标正文\n\n图像 2：  \n1.（x：36.7%，y：50.4%）第二张\n\n图像 3：  \n1.（x：60%，y：30%）第三张'
    )
    expect(composeImageMarkupMessage(message.content, message.attachments)).toEqual(message)
  } finally {
    await i18n.changeLanguage(previousLanguage)
  }
})

test('uses the bytes shown in the viewer even after its local file or URL changes', async () => {
  const runtime = vi.spyOn(runtimeEnvironment, 'isElectronRuntime').mockReturnValue(true)
  const read = vi
    .spyOn(electronFiles, 'readElectronLocalFile')
    .mockResolvedValueOnce(new TextEncoder().encode('displayed pixels').buffer)
    .mockResolvedValueOnce(new TextEncoder().encode('replacement pixels').buffer)
  const revoke = vi.fn()
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview-snapshot')
      static revokeObjectURL = revoke
    }
  )
  try {
    const attachment = {
      id: -1,
      filename: 'image.png',
      local_path: '/tmp/image.png',
      file_size: 16,
      mime_type: 'image/png',
      file_extension: '.png',
      created_at: '',
      status: 'ready' as const,
    }
    const { result } = renderHook(useAttachmentImageServices)
    const preview = await result.current.load(attachment)
    const lightbox = result.current.renderLightbox!({
      attachment,
      filename: attachment.filename,
      url: preview.url,
      blob: preview.blob,
      loading: false,
      onClose: vi.fn(),
      onError: vi.fn(),
      onDownload: vi.fn(),
    })
    preview.release?.()
    const submit = vi.fn().mockImplementation(async source => {
      const file = await source.loadFile()
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(file)
      })
      expect(text).toBe('displayed pixels')
      return true
    })
    render(<ImageEditContext.Provider value={{ submit }}>{lightbox}</ImageEditContext.Provider>)
    fireEvent.click(screen.getByTestId('attachment-image-tool-background'))
    await expect(submit.mock.results[0]?.value).resolves.toBe(true)
    expect(read).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith(preview.url)
  } finally {
    runtime.mockRestore()
    read.mockRestore()
  }
})

vi.mock('@/hooks/useLocalWorkspaceOpeners', () => ({
  useLocalWorkspaceOpeners: (enabled: boolean) => ({
    data: enabled
      ? [
          { id: 'vscode', category: 'general', available: true },
          { id: 'cursor', category: 'general', available: false },
        ]
      : undefined,
  }),
}))
vi.mock('@/api/dsh/desktopHost', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/dsh/desktopHost')>()),
  invokeDesktopHost: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/local-terminal', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/local-terminal')>()),
  openLocalFile: vi.fn().mockResolvedValue(undefined),
  revealLocalFile: vi.fn().mockResolvedValue(undefined),
}))

test('opens the original local image in the chosen application or its containing folder', () => {
  const localPath = '/tmp/image.png'
  render(
    <DesktopImagePreview
      attachment={{
        id: -1,
        filename: 'image.png',
        file_size: 1,
        mime_type: 'image/png',
        file_extension: '.png',
        created_at: '',
        status: 'ready',
      }}
      filename="image.png"
      localPath={localPath}
      url="blob:test-preview"
      loading={false}
      loadFile={vi.fn()}
      onClose={vi.fn()}
      onDownload={vi.fn()}
      onError={vi.fn()}
    />
  )
  fireEvent.click(screen.getByTestId('attachment-image-open'))
  expect(openLocalFile).toHaveBeenCalledWith(localPath)
  const menu = screen.getByTestId('attachment-image-open-with')
  fireEvent.click(menu)
  expect(screen.queryByTestId('attachment-image-open-with-cursor')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('attachment-image-open-with-vscode'))
  expect(invokeDesktopHost).toHaveBeenCalledWith('workspace.openFile', {
    opener: 'vscode',
    path: localPath,
  })
  fireEvent.click(menu)
  fireEvent.click(screen.getByTestId('attachment-image-reveal'))
  expect(revealLocalFile).toHaveBeenCalledWith(localPath)
})

test('background removal sends the original, while image erase also sends the selection mask', async () => {
  const source = new File(['original'], 'source.png', { type: 'image/png' })
  const image = {
    name: source.name,
    mimeType: source.type,
    loadFile: vi.fn().mockResolvedValue(source),
  }
  const upload = vi.fn(async (file: File) => ({
    id: -1,
    filename: file.name,
    file_size: file.size,
    mime_type: file.type,
    file_extension: '.png',
    created_at: '',
    status: 'ready' as const,
  }))
  const submit = vi.fn().mockResolvedValue(true)
  const { result } = renderHook(() => useImageEditSubmission({ enabled: true, upload, submit }))

  await result.current!.submit(image, { kind: 'background' })
  const [backgroundPrompt, backgroundOptions] = submit.mock.calls[0]!
  expect(backgroundPrompt).toContain('Make the background transparent.')
  expect(
    (await resolvePreparingAttachments(backgroundOptions.standaloneAttachments)).map(
      file => file.filename
    )
  ).toEqual(['source.png'])

  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width: 100, height: 100, close: vi.fn() })
  )
  vi.stubGlobal(
    'Path2D',
    class {
      constructor(readonly path: string) {}
    }
  )
  const maskCanvas = { fillRect: vi.fn(), scale: vi.fn(), stroke: vi.fn(), strokeStyle: '' }
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(maskCanvas as unknown as CanvasRenderingContext2D)
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation(callback => callback(new Blob(['mask'], { type: 'image/png' })))
  try {
    await result.current!.submit(image, {
      kind: 'erase',
      strokes: [
        {
          width: 4,
          points: [
            { x: 40, y: 25 },
            { x: 60, y: 30 },
          ],
        },
      ],
    })
    const [erasePrompt, eraseOptions] = submit.mock.calls[1]!
    expect(erasePrompt).toContain('remove the area marked in white in the second image')
    expect(
      (await resolvePreparingAttachments(eraseOptions.standaloneAttachments)).map(
        file => file.filename
      )
    ).toEqual(['source.png', 'selection-mask.png'])
    expect(image.loadFile).toHaveBeenCalledTimes(2)
    expect(maskCanvas.strokeStyle).toBe('white')
    expect(maskCanvas.stroke).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'M 40 25 L 60 30' })
    )
  } finally {
    context.mockRestore()
    toBlob.mockRestore()
  }
})

test('exports partially erased markup to the owning draft without sending a message', async () => {
  const bitmap = { width: 100, height: 100, close: vi.fn() }
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
  vi.stubGlobal(
    'Path2D',
    class {
      constructor(readonly path: string) {}
    }
  )
  const output = { drawImage: vi.fn() }
  const operations: string[] = []
  const layer = {
    globalCompositeOperation: 'source-over',
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    stroke: vi.fn(() => operations.push(layer.globalCompositeOperation)),
  }
  const contexts = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValueOnce(output as unknown as CanvasRenderingContext2D)
    .mockReturnValueOnce(layer as unknown as CanvasRenderingContext2D)
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
    callback(new Blob(['image'], { type: 'image/png' }))
  })
  const upload = vi.fn(async (file: File) => ({
    id: -1,
    filename: file.name,
    file_size: file.size,
    mime_type: file.type,
    file_extension: '.png',
    created_at: '',
    status: 'ready' as const,
  }))
  const submit = vi.fn().mockResolvedValue(true)
  const replaceImageAttachment = vi.fn().mockResolvedValue({ id: 43 })
  const { result } = renderHook(() =>
    useImageEditSubmission({
      enabled: true,
      scope: 'draft',
      upload,
      submit,
      replaceImageAttachment,
    })
  )
  const source = new File(['source'], 'source.jpg', { type: 'image/jpeg' })
  const { signal } = new AbortController()
  try {
    await result.current!.saveMarkup!(
      42,
      async () => source,
      {
        kind: 'markup',
        instructions: '',
        marks: [
          {
            color: '#ff3333',
            width: 1,
            points: [
              { x: 10, y: 10 },
              { x: 90, y: 90 },
            ],
            erasures: [
              {
                width: 3,
                points: [
                  { x: 45, y: 45 },
                  { x: 55, y: 55 },
                ],
              },
            ],
          },
        ],
      },
      signal
    )
    expect(submit).not.toHaveBeenCalled()
    expect(replaceImageAttachment).toHaveBeenCalledExactlyOnceWith(
      'draft',
      42,
      expect.objectContaining({
        name: 'source.png',
        type: 'image/png',
      }),
      [],
      signal
    )
    expect(operations).toEqual(['source-over', 'destination-out'])
    expect(output.drawImage).toHaveBeenNthCalledWith(1, bitmap, 0, 0)
    expect(output.drawImage).toHaveBeenNthCalledWith(2, expect.any(HTMLCanvasElement), 0, 0)
    expect(bitmap.close).toHaveBeenCalledOnce()
  } finally {
    contexts.mockRestore()
    toBlob.mockRestore()
  }
})

test('keeps the image and resize choices available after a failed edit', async () => {
  const source = new File(['image'], 'image.png', { type: 'image/png' })
  const loadFile = vi.fn().mockResolvedValue(source)
  const submit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const close = vi.fn()
  render(
    <ImageEditContext.Provider value={{ submit }}>
      <DesktopImagePreview
        attachment={{
          id: -1,
          filename: source.name,
          file_size: source.size,
          mime_type: source.type,
          file_extension: '.png',
          created_at: '',
          status: 'ready',
        }}
        filename={source.name}
        url="blob:test-preview"
        loading={false}
        loadFile={loadFile}
        onClose={close}
        onDownload={vi.fn()}
        onError={vi.fn()}
      />
    </ImageEditContext.Provider>
  )

  fireEvent.click(screen.getByTestId('attachment-image-tool-resize'))
  const widescreen = screen.getByTestId('attachment-image-resize-16:9')
  fireEvent.click(widescreen)
  await screen.findByRole('alert')
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
    'src',
    'blob:test-preview'
  )

  fireEvent.click(screen.getByTestId('attachment-image-tool-resize'))
  fireEvent.click(screen.getByTestId('attachment-image-resize-16:9'))
  expect(submit).toHaveBeenNthCalledWith(
    2,
    { name: source.name, mimeType: source.type, loadFile },
    { kind: 'resize', ratio: '16:9' }
  )
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(loadFile).not.toHaveBeenCalled()
})

test('fits oversized images and uses native pixels for explicit zoom', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(
        private callback: (
          entries: Array<{ contentRect: { width: number; height: number } }>
        ) => void
      ) {}
      observe() {
        this.callback([{ contentRect: { width: 800, height: 600 } }])
      }
      disconnect = vi.fn()
    }
  )
  render(
    <DesktopImagePreview
      attachment={{
        id: -1,
        filename: 'image.png',
        file_size: 1,
        mime_type: 'image/png',
        file_extension: '.png',
        created_at: '',
        status: 'ready',
      }}
      filename="image.png"
      url="blob:test-preview"
      loading={false}
      loadFile={vi.fn()}
      onClose={vi.fn()}
      onDownload={vi.fn()}
      onError={vi.fn()}
    />
  )
  const image = screen.getByTestId('attachment-image-lightbox-image')
  Object.defineProperties(image, {
    naturalWidth: { value: 1600 },
    naturalHeight: { value: 800 },
  })
  fireEvent.load(image)
  expect(image).toHaveStyle({ width: '800px', height: '400px' })

  const zoom = screen.getByTestId('attachment-image-zoom-value')
  fireEvent.change(zoom, { target: { value: '100' } })
  expect(image).toHaveStyle({ width: '1600px', height: '800px' })
  fireEvent.change(zoom, { target: { value: '' } })
  expect(image).toHaveStyle({ width: '800px', height: '400px' })

  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 400,
    right: 800,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  fireEvent.wheel(image, { deltaY: -50, clientX: 400, clientY: 200 })
  expect(image).toHaveStyle({ width: '800px', height: '400px' })
  expect(
    fireEvent.wheel(image, {
      ctrlKey: true,
      deltaY: -50,
      clientX: 400,
      clientY: 200,
    })
  ).toBe(false)
  expect(zoom).toHaveValue('82')
  expect(image).toHaveStyle({ width: '1312px', height: '656px' })
})

test('places an unnumbered draft, numbers saved comments and sends Codex-formatted text with the original image', async () => {
  const source = new File(['image'], 'image.png', { type: 'image/png' })
  const attachment = {
    id: -1,
    filename: source.name,
    file_size: source.size,
    mime_type: source.type,
    file_extension: '.png',
    created_at: '',
    status: 'ready' as const,
  }
  const upload = vi.fn().mockResolvedValue(attachment)
  const submit = vi.fn().mockResolvedValue(true)
  const close = vi.fn()
  const submitComposer = vi.fn()
  const removeDraftAttachment = vi.fn().mockResolvedValue(undefined)
  function Preview() {
    const editor = useImageEditSubmission({
      enabled: true,
      scope: 'comment-draft',
      upload,
      submit,
      removeDraftAttachment,
    })
    return (
      <ImageEditContext.Provider value={editor}>
        <DesktopImagePreview
          attachment={attachment}
          fromComposer
          filename={source.name}
          url="blob:test-preview"
          loading={false}
          loadFile={async () => source}
          onClose={close}
          onDownload={vi.fn()}
          onError={vi.fn()}
        />
      </ImageEditContext.Provider>
    )
  }
  const previousLanguage = i18n.language
  await i18n.changeLanguage('zh-CN')
  try {
    render(
      <form
        onSubmit={event => {
          event.preventDefault()
          submitComposer()
        }}
      >
        <Preview />
      </form>
    )
    const closeButton = screen.getByTestId('attachment-image-lightbox-close')
    await waitFor(() => expect(closeButton).toHaveFocus())
    fireEvent.click(screen.getByTestId('attachment-image-tool-comment'))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByTestId('attachment-image-comment-count')).not.toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('attachment-image-tool-comment'))
    expect(screen.getByTestId('attachment-image-comment-count')).toHaveTextContent(
      '点击图像以添加评论'
    )
    expect(screen.getByTestId('attachment-image-edit-send')).toBeDisabled()
    const surface = screen.getByTestId('attachment-image-edit-surface')
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 20,
      width: 1000,
      height: 500,
      right: 1100,
      bottom: 520,
      x: 100,
      y: 20,
      toJSON: () => ({}),
    })
    for (const type of ['pointerdown', 'pointerup']) {
      fireEvent(
        surface,
        new MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: 467,
          clientY: 272,
        })
      )
    }
    expect(screen.getByTestId('attachment-image-comment-draft-pin')).toBeEmptyDOMElement()
    expect(screen.queryByTestId('attachment-image-comment-pin')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('attachment-image-comment-input'), {
      target: { value: '看看这个' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存评论' }))
    expect(screen.getByTestId('attachment-image-comment-pin')).toHaveTextContent('1')
    expect(screen.getByTestId('attachment-image-comment-count')).toHaveTextContent('1 条评论')
    expect(screen.getByTestId('attachment-image-edit-send')).toHaveFocus()
    expect(submit).not.toHaveBeenCalled()
    expect(submitComposer).not.toHaveBeenCalled()
    expect(removeDraftAttachment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('attachment-image-comment-pin'))
    const savedCommentEditor = screen.getByTestId('attachment-image-comment-input')
    expect(savedCommentEditor).toBeInstanceOf(HTMLTextAreaElement)
    expect(savedCommentEditor).toHaveValue('看看这个')
    fireEvent.change(savedCommentEditor, { target: { value: '未保存的改动' } })
    fireEvent.click(screen.getByTestId('attachment-image-comment-cancel'))

    fireEvent.click(surface, { detail: 0 })
    expect(screen.getByTestId('attachment-image-comment-pin')).toHaveTextContent('1')
    expect(screen.getByTestId('attachment-image-comment-draft-pin')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('attachment-image-comment-input'), {
      target: { value: '也看看这里' },
    })
    for (const type of ['pointerdown', 'pointerup']) {
      fireEvent(surface, new MouseEvent(type, { bubbles: true, clientX: 600, clientY: 270 }))
    }
    expect(screen.getByTestId('attachment-image-comment-count')).toHaveTextContent('2 条评论')
    fireEvent.click(screen.getByTestId('attachment-image-edit-send'))
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      '图像 1：  \n1.（x：36.7%，y：50.4%）看看这个  \n2.（x：50%，y：50%）也看看这里',
      { standaloneAttachments: [expect.objectContaining({ filename: 'image.png' })] }
    )
    expect(submitComposer).not.toHaveBeenCalled()
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(removeDraftAttachment).toHaveBeenCalledExactlyOnceWith('comment-draft', attachment.id)
    expect(upload).not.toHaveBeenCalled()
    await resolvePreparingAttachments(submit.mock.calls[0]![1].standaloneAttachments)
    expect(upload).toHaveBeenCalledExactlyOnceWith(source)
  } finally {
    await i18n.changeLanguage(previousLanguage)
  }
})

test('retains fast brush samples and sends markup with image-relative comments', async () => {
  const source = new File(['image'], 'image.png', { type: 'image/png' })
  const attachment = {
    id: -1,
    filename: source.name,
    file_size: source.size,
    mime_type: source.type,
    file_extension: '.png',
    created_at: '',
    status: 'ready' as const,
  }
  const submit = vi.fn().mockResolvedValue(false)
  render(
    <ImageEditContext.Provider value={{ submit }}>
      <DesktopImagePreview
        attachment={attachment}
        filename={source.name}
        url="blob:test-preview"
        loading={false}
        loadFile={async () => source}
        onClose={vi.fn()}
        onDownload={vi.fn()}
        onError={vi.fn()}
      />
    </ImageEditContext.Provider>
  )
  fireEvent.click(screen.getByTestId('attachment-image-tool-markup'))
  const surface = screen.getByTestId('attachment-image-edit-surface')
  Object.defineProperties(surface, {
    setPointerCapture: { value: vi.fn() },
    hasPointerCapture: { value: () => true },
  })
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    right: 100,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, clientX: 15, clientY: 20 }))
  const move = new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 30 })
  Object.defineProperty(move, 'getCoalescedEvents', {
    value: () => [
      { clientX: 18, clientY: 35 },
      { clientX: 28, clientY: 15 },
      { clientX: 40, clientY: 30 },
    ],
  })
  fireEvent(surface, move)
  fireEvent(surface, new MouseEvent('pointerup', { bubbles: true, clientX: 45, clientY: 50 }))
  const send = screen.getByTestId('attachment-image-edit-send')
  fireEvent.click(send)
  expect(submit.mock.calls[0]?.[1]).toEqual({
    kind: 'markup',
    instructions: '',
    marks: [
      {
        points: [
          { x: 15, y: 20 },
          { x: 18, y: 35 },
          { x: 28, y: 15 },
          { x: 40, y: 30 },
          { x: 45, y: 50 },
        ],
        width: 0.65,
        color: '#ff3333',
      },
    ],
  })
  await screen.findByRole('alert')
  fireEvent.change(screen.getByTestId('attachment-image-markup-shapes'), {
    target: { value: 'rectangle' },
  })
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, clientX: 25, clientY: 35 }))
  fireEvent(surface, new MouseEvent('pointerup', { bubbles: true, clientX: 50, clientY: 60 }))
  expect(surface.querySelector('[data-mark-index="1"] path')).toHaveAttribute(
    'd',
    'M 25 35 h 25 v 25 h -25 Z'
  )
  fireEvent.click(screen.getByTestId('attachment-image-markup-text'))
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 40 }))
  const textInput = screen.getByTestId('attachment-image-markup-text-input')
  fireEvent.change(textInput, { target: { value: 'Corner' } })
  fireEvent.click(screen.getByTestId('attachment-image-markup-save-text'))
  expect(surface.querySelector('text')).toHaveTextContent('Corner')
  fireEvent.click(screen.getByTestId('attachment-image-markup-eraser'))
  fireEvent(surface, new MouseEvent('pointerdown', { bubbles: true, clientX: 54, clientY: 55 }))
  fireEvent(surface, new MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 55 }))
  expect(surface.querySelector('[data-mark-index="1"]')).toHaveAttribute('mask')
  expect(surface.querySelector('[data-mark-index="0"]')).not.toHaveAttribute('mask')
  fireEvent(surface, new MouseEvent('pointerup', { bubbles: true, clientX: 47, clientY: 55 }))
  fireEvent.click(screen.getByTestId('attachment-image-edit-undo'))
  expect(surface.querySelector('[data-mark-index="1"]')).not.toHaveAttribute('mask')
  fireEvent.click(screen.getByTestId('attachment-image-edit-redo'))
  expect(surface.querySelector('[data-mark-index="1"] path')).toHaveAttribute(
    'd',
    'M 25 35 h 25 v 25 h -25 Z'
  )
  fireEvent.click(screen.getByTestId('attachment-image-markup-comment'))
  fireEvent.click(screen.getByTestId('attachment-image-edit-surface'), { detail: 0 })
  fireEvent.change(screen.getByTestId('attachment-image-comment-input'), {
    target: { value: 'Review this corner' },
  })
  fireEvent.click(screen.getByTestId('attachment-image-markup-pen'))
  expect(screen.getByTestId('attachment-image-edit-surface')).toBe(surface)
  const input = screen.getByTestId('attachment-image-markup-instructions')
  fireEvent.change(input, { target: { value: 'Compare the two corners' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(submit.mock.calls[1]?.[1]).toMatchObject({
    kind: 'markup',
    instructions: 'Compare the two corners',
    comments: [{ x: 50, y: 50, text: 'Review this corner' }],
    marks: [
      expect.objectContaining({ width: 0.65 }),
      expect.objectContaining({
        shape: 'rectangle',
        erasures: [
          {
            points: [
              { x: 54, y: 55 },
              { x: 50, y: 55 },
              { x: 47, y: 55 },
            ],
            width: 4,
          },
        ],
      }),
      expect.objectContaining({ text: 'Corner' }),
    ],
  })
  await screen.findByRole('alert')
})
