import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OpenCutEditorDialog } from '@wecode/features/video/materials_to_video/OpenCutEditorDialog'
import { materialTimelineApi } from '@wecode/features/video/materials_to_video/api'
import { OPENCUT_SAVE_TIMEOUT_MS } from '@wecode/features/video/materials_to_video/useOpenCutHostControls'

const toast = jest.fn()
const translate = (key: string) => key
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }))
jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: translate }) }))
jest.mock('@wecode/features/video/materials_to_video/api', () => ({
  materialTimelineApi: { openInOpenCut: jest.fn() },
}))

async function openEditor(onRender = jest.fn().mockResolvedValue(undefined), onSaved = jest.fn()) {
  const view = render(
    <OpenCutEditorDialog
      sessionId="133"
      artifactId="timeline-1"
      onRender={onRender}
      onSaved={onSaved}
    />
  )
  fireEvent.click(screen.getByTestId('material-timeline-open-opencut'))
  const frame = (await screen.findByTestId('material-timeline-opencut-frame')) as HTMLIFrameElement
  const post = jest.spyOn(frame.contentWindow!, 'postMessage')
  const message = (
    data: Record<string, unknown>,
    origin = 'https://editor.test',
    source = frame.contentWindow
  ) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { origin, source, data: { protocolVersion: 1, ...data } })
      )
    })
  const ready = () => {
    message({ type: 'storycut:opencut-ready', capabilities: ['save'] })
    message({ type: 'storycut:opencut-host-ready' })
  }
  const saveRequest = () =>
    post.mock.calls.filter(([data]) => data.type === 'storycut:host-save-request').at(-1)![0]
  return { ...view, frame, post, message, ready, saveRequest, onRender, onSaved }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(materialTimelineApi.openInOpenCut).mockResolvedValue({
    open_url: 'https://editor.test/storycut/import?url=source&returnUrl=save&embed=wegent',
  })
})

afterEach(() => {
  jest.useRealTimers()
})

test('requests the same host-v1 actions as weibo-wegent and verifies frame origin and source', async () => {
  const editor = await openEditor()
  const url = new URL(editor.frame.src)
  expect(url.searchParams.get('url')).toBe('source')
  expect(url.searchParams.get('returnUrl')).toBe('save')
  expect(url.searchParams.get('controlMode')).toBe('host-v1')
  expect(url.searchParams.get('hostActions')).toBe('save,save-and-render,close')
  expect(screen.getByTestId('opencut-host-save-render')).toBeDisabled()
  editor.message({ type: 'storycut:opencut-host-ready' }, 'https://untrusted.test')
  editor.message({ type: 'storycut:opencut-host-ready' }, 'https://editor.test', window)
  editor.message({ type: 'storycut:opencut-host-ready', protocolVersion: 2 })
  expect(screen.getByTestId('opencut-host-save-render')).toBeDisabled()
  editor.ready()
  expect(editor.post).toHaveBeenCalledWith(
    { type: 'storycut:host-ready', protocolVersion: 1 },
    'https://editor.test'
  )
  expect(screen.getByTestId('opencut-host-save-render')).toBeEnabled()
})

test('renders only after the matching save succeeds and then closes', async () => {
  const editor = await openEditor()
  editor.ready()
  fireEvent.click(screen.getByTestId('opencut-host-save-render'))
  fireEvent.click(screen.getByTestId('opencut-host-save-render'))
  const request = editor.saveRequest()
  expect(
    editor.post.mock.calls.filter(([data]) => data.type === 'storycut:host-save-request')
  ).toHaveLength(1)
  expect(editor.onRender).not.toHaveBeenCalled()
  editor.message({ type: 'storycut:opencut-save-result', requestId: 'unrelated', ok: true })
  expect(editor.onRender).not.toHaveBeenCalled()
  editor.message({ type: 'storycut:opencut-save-result', requestId: request.requestId, ok: true })
  await waitFor(() => expect(editor.onRender).toHaveBeenCalledTimes(1))
  expect(editor.onSaved).toHaveBeenCalledTimes(1)
  await waitFor(() =>
    expect(screen.queryByTestId('material-timeline-opencut-frame')).not.toBeInTheDocument()
  )
})

test('save alone leaves the editor open and does not render', async () => {
  const editor = await openEditor()
  editor.ready()
  fireEvent.click(screen.getByTestId('opencut-host-save'))
  editor.message({
    type: 'storycut:opencut-save-result',
    requestId: editor.saveRequest().requestId,
    ok: true,
  })
  await waitFor(() => expect(editor.onSaved).toHaveBeenCalledTimes(1))
  expect(editor.onRender).not.toHaveBeenCalled()
  expect(screen.getByTestId('material-timeline-opencut-frame')).toBeInTheDocument()
})

test('save failure remains visible and never starts rendering', async () => {
  const editor = await openEditor()
  editor.ready()
  fireEvent.click(screen.getByTestId('opencut-host-save-render'))
  editor.message({
    type: 'storycut:opencut-save-result',
    requestId: editor.saveRequest().requestId,
    ok: false,
    error: 'Save rejected',
  })
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith({ variant: 'destructive', description: 'Save rejected' })
  )
  expect(editor.onRender).not.toHaveBeenCalled()
  expect(screen.getByTestId('opencut-host-save-render')).toBeEnabled()
  expect(screen.getByTestId('material-timeline-opencut-frame')).toBeInTheDocument()
})

test('render submission failure keeps the saved editor open', async () => {
  const editor = await openEditor(jest.fn().mockRejectedValue(new Error('Offline')))
  editor.ready()
  fireEvent.click(screen.getByTestId('opencut-host-save-render'))
  editor.message({
    type: 'storycut:opencut-save-result',
    requestId: editor.saveRequest().requestId,
    ok: true,
  })
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith({
      variant: 'destructive',
      description: 'materialEditor.timeline.renderSubmitFailed',
    })
  )
  expect(screen.getByTestId('material-timeline-opencut-frame')).toBeInTheDocument()
})

test('save timeout is an error, not permission to render', async () => {
  jest.useFakeTimers()
  const editor = await openEditor()
  editor.ready()
  fireEvent.click(screen.getByTestId('opencut-host-save-render'))
  await act(async () => {
    jest.advanceTimersByTime(OPENCUT_SAVE_TIMEOUT_MS)
  })
  expect(toast).toHaveBeenCalledWith({
    variant: 'destructive',
    description: 'materialEditor.timeline.saveTimeout',
  })
  expect(editor.onRender).not.toHaveBeenCalled()
  expect(screen.getByTestId('material-timeline-opencut-frame')).toBeInTheDocument()
})

test('closing cancels pending saves and ignores late results', async () => {
  const editor = await openEditor()
  editor.ready()
  fireEvent.click(screen.getByTestId('opencut-host-save-render'))
  const requestId = editor.saveRequest().requestId
  editor.message({ type: 'storycut:opencut-close' })
  editor.message({ type: 'storycut:opencut-save-result', requestId, ok: true })
  await act(async () => {})
  expect(editor.onRender).not.toHaveBeenCalled()
  expect(screen.queryByTestId('material-timeline-opencut-frame')).not.toBeInTheDocument()
  editor.unmount()
})

test('unmounting while saving does not render or report an error after leaving', async () => {
  const editor = await openEditor()
  editor.ready()
  fireEvent.click(screen.getByTestId('opencut-host-save-render'))
  editor.unmount()
  await act(async () => {})
  expect(editor.onRender).not.toHaveBeenCalled()
  expect(toast).not.toHaveBeenCalled()
})

test('changing the timeline cancels an in-flight save', async () => {
  const editor = await openEditor()
  editor.ready()
  fireEvent.click(screen.getByTestId('opencut-host-save-render'))
  editor.rerender(
    <OpenCutEditorDialog sessionId="134" artifactId="timeline-2" onRender={editor.onRender} />
  )
  await act(async () => {})
  expect(editor.onRender).not.toHaveBeenCalled()
  expect(screen.queryByTestId('material-timeline-opencut-frame')).not.toBeInTheDocument()
})
