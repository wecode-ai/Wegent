import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { MarkdownDiagramPreview } from './MarkdownDiagramPreview'

const fileViewerMocks = vi.hoisted(() => ({
  render: vi.fn(),
}))
const appearanceMocks = vi.hoisted(() => ({
  resolvedMode: 'light' as 'dark' | 'light',
}))
const imageExportMocks = vi.hoisted(() => ({
  copy: vi.fn(),
  render: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  save: vi.fn(),
}))

vi.mock('@file-viewer/react', () => ({
  default: (props: Record<string, unknown>) => {
    fileViewerMocks.render(props)
    return (
      <div data-testid="file-viewer">
        <svg className="drawing-diagram-svg" />
      </div>
    )
  },
}))

vi.mock('@file-viewer/preset-engineering', () => ({ default: {} }))
vi.mock('@/features/appearance', () => ({
  useOptionalAppearance: () => ({ resolvedMode: appearanceMocks.resolvedMode }),
}))
vi.mock('./diagramImageExport', () => ({
  copyDiagramPng: imageExportMocks.copy,
  renderDiagramPng: imageExportMocks.render,
  saveDiagramPng: imageExportMocks.save,
}))

beforeEach(() => {
  fileViewerMocks.render.mockClear()
  appearanceMocks.resolvedMode = 'light'
  imageExportMocks.copy.mockClear()
  imageExportMocks.render.mockClear()
  imageExportMocks.save.mockClear()
})

test('renders PlantUML source through the drawing file viewer', () => {
  render(<MarkdownDiagramPreview code={'@startuml\nAlice -> Bob\n@enduml'} language="plantuml" />)

  expect(screen.getByTestId('assistant-diagram-preview')).toHaveAttribute(
    'data-language',
    'plantuml'
  )
  expect(fileViewerMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: 'diagram.plantuml',
      type: 'plantuml',
      options: expect.objectContaining({
        drawing: {
          plantumlServerUrl: 'https://www.plantuml.com/plantuml/svg',
        },
      }),
    })
  )
})

test('normalizes mmd fences to the Mermaid drawing renderer', () => {
  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mmd" />)

  expect(screen.getByTestId('assistant-diagram-preview')).toHaveAttribute(
    'data-language',
    'mermaid'
  )
  expect(fileViewerMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: 'diagram.mermaid',
      type: 'mermaid',
    })
  )
})

test('uses the current Wework dark theme', () => {
  appearanceMocks.resolvedMode = 'dark'

  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)

  expect(fileViewerMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        theme: 'dark',
      }),
    })
  )
})

test('copies and saves the rendered diagram as a PNG', async () => {
  const user = userEvent.setup()
  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)

  await user.click(screen.getByTestId('diagram-copy-image-button'))
  await waitFor(() => {
    expect(imageExportMocks.copy).toHaveBeenCalledWith(expect.any(Blob))
  })

  await user.click(screen.getByTestId('diagram-save-image-button'))
  await waitFor(() => {
    expect(imageExportMocks.save).toHaveBeenCalledWith(expect.any(Blob), 'mermaid-diagram.png')
  })
})
