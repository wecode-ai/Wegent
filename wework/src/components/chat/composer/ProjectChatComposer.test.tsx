import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ProjectChatComposer } from './ProjectChatComposer'
import type { ProjectChatComposerProps } from './ProjectChatComposer'

function minimalProps(overrides: Partial<ProjectChatComposerProps> = {}): ProjectChatComposerProps {
  return {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    disabled: false,
    placeholder: 'Message',
    models: [],
    selectedModel: null,
    selectedModelOptions: {},
    isModelSelectionReady: true,
    attachments: [],
    uploadingFiles: new Map(),
    attachmentErrors: new Map(),
    onSelectModel: vi.fn(),
    onSelectModelOption: vi.fn(),
    onFileSelect: vi.fn(),
    onRemoveAttachment: vi.fn(),
    projectWork: {
      projects: [],
      devices: [],
      executionMode: 'current_workspace',
      onSelectProject: vi.fn(),
      onSelectStandaloneDevice: vi.fn(),
      onExecutionModeChange: vi.fn(),
    },
    showProjectWorkBar: false,
    ...overrides,
  }
}

describe('ProjectChatComposer link preview', () => {
  test('shows a link preview card when the input contains a URL', () => {
    render(
      <ProjectChatComposer
        {...minimalProps({
          value: '使用gh https://github.com/wecode-ai/Wegent/actions/runs/30603861794',
        })}
      />
    )

    expect(screen.getByTestId('link-preview-card')).toBeInTheDocument()
    expect(screen.getByTestId('link-preview-url')).toHaveTextContent(
      'https://github.com/wecode-ai/Wegent/actions/runs/30603861794'
    )
  })

  test('removes the link preview and clears the URL from the value', () => {
    const onChange = vi.fn()
    render(
      <ProjectChatComposer
        {...minimalProps({
          value: '使用gh https://github.com/wecode-ai/Wegent/actions/runs/30603861794',
          onChange,
        })}
      />
    )

    fireEvent.click(screen.getByTestId('link-preview-remove'))
    expect(onChange).toHaveBeenCalledWith('使用gh')
  })

  test('hides the link preview when the URL is removed from the value', () => {
    const { rerender } = render(
      <ProjectChatComposer {...minimalProps({ value: 'Check https://example.com' })} />
    )

    expect(screen.getByTestId('link-preview-card')).toBeInTheDocument()

    rerender(<ProjectChatComposer {...minimalProps({ value: 'No link here' })} />)
    expect(screen.queryByTestId('link-preview-card')).not.toBeInTheDocument()
  })
})
