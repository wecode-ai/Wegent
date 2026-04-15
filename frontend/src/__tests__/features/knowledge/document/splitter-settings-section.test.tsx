// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import { SplitterSettingsSection } from '@/features/knowledge/document/components/SplitterSettingsSection'
import { normalizeSplitterConfigForDisplay, type SplitterConfig } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'knowledge:document.splitter.type': 'Chunking Type',
        'knowledge:document.splitter.flat': 'Flat',
        'knowledge:document.splitter.hierarchical': 'Hierarchical',
        'knowledge:document.splitter.semantic': 'Semantic',
        'knowledge:document.splitter.fileAware': 'File-aware',
        'knowledge:document.splitter.titleEnhancement': 'Title enhancement',
        'knowledge:document.splitter.separator': 'Separator',
        'knowledge:document.splitter.separatorHint': 'Character(s) used to split document',
        'knowledge:document.splitter.chunkSize': 'Max Chunk Size',
        'knowledge:document.splitter.chunkSizeHint': 'Maximum characters per chunk (128-8192)',
        'knowledge:document.splitter.chunkOverlap': 'Chunk Overlap',
        'knowledge:document.splitter.chunkOverlapHint': 'Overlap characters between chunks',
        'knowledge:document.splitter.parentChunkSize': 'Parent chunk size',
        'knowledge:document.splitter.childChunkSize': 'Child chunk size',
        'knowledge:document.splitter.childChunkOverlap': 'Child chunk overlap',
        'knowledge:document.splitter.parentSeparator': 'Parent separator',
        'knowledge:document.splitter.parentSeparatorHint':
          'Character(s) used to split parent chunks',
        'knowledge:document.splitter.childSeparator': 'Child separator',
        'knowledge:document.splitter.childSeparatorHint': 'Character(s) used to split child chunks',
        'knowledge:document.splitter.characters': 'characters',
        'knowledge:document.splitter.bufferSize': 'Buffer size',
        'knowledge:document.splitter.breakpointThreshold': 'Breakpoint threshold',
      }

      return translations[key] ?? key
    },
  }),
}))

jest.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({
    value,
    onValueChange,
    items,
    disabled,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    items: Array<{ value: string; label: string }>
    disabled?: boolean
  }) => {
    const isChunkStrategySelect =
      items.length === 3 &&
      items.every(item =>
        ['flat', 'hierarchical', 'semantic', 'smart', 'sentence'].includes(item.value)
      )

    return (
      <select
        data-testid={isChunkStrategySelect ? 'chunk-strategy-select' : 'format-enhancement-select'}
        disabled={disabled}
        value={value}
        onChange={event => onValueChange?.(event.target.value)}
      >
        {items.map(item => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    )
  },
}))

jest.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    id,
    checked,
    onCheckedChange,
    disabled,
    ...props
  }: {
    id?: string
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
    disabled?: boolean
    [key: string]: unknown
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      {...props}
      onChange={event => onCheckedChange?.(event.target.checked)}
    />
  ),
}))

function expectBefore(before: HTMLElement, after: HTMLElement) {
  expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}

function StatefulSplitterSettingsSection({
  initialConfig,
}: {
  initialConfig?: Partial<SplitterConfig>
}) {
  const [config, setConfig] = useState<Partial<SplitterConfig>>(initialConfig ?? {})

  return <SplitterSettingsSection config={config} onChange={setConfig} />
}

describe('SplitterSettingsSection', () => {
  it('shows flat + file-aware + title enhancement as the default config', () => {
    render(<SplitterSettingsSection config={{}} onChange={jest.fn()} />)

    expect(screen.getByTestId('chunk-strategy-select')).toHaveValue('flat')
    expect(screen.getByTestId('file-aware-checkbox')).toBeChecked()
    expect(screen.getByTestId('title-enhancement-checkbox')).toBeChecked()
  })

  it('maps legacy smart config to the new display model', () => {
    render(
      <SplitterSettingsSection config={{ type: 'smart' } as SplitterConfig} onChange={jest.fn()} />
    )

    expect(screen.getByTestId('chunk-strategy-select')).toHaveValue('flat')
    expect(screen.getByTestId('file-aware-checkbox')).toBeChecked()
    expect(screen.getByTestId('title-enhancement-checkbox')).toBeChecked()
  })

  it.each([
    ['semantic', { type: 'semantic' }, 'semantic'],
    ['sentence', { type: 'sentence' }, 'flat'],
  ] as const)(
    'normalizes legacy %s config with markdown enhancement disabled',
    (_, config, chunkStrategy) => {
      const normalized = normalizeSplitterConfigForDisplay(config as SplitterConfig)

      expect(normalized.chunk_strategy).toBe(chunkStrategy)
      expect(normalized.markdown_enhancement?.enabled).toBe(false)
    }
  )

  it('normalizes hierarchical defaults with parent and child separators', () => {
    const normalized = normalizeSplitterConfigForDisplay({
      chunk_strategy: 'hierarchical',
    } as SplitterConfig)

    expect(normalized.hierarchical_config).toEqual({
      parent_chunk_size: 2048,
      child_chunk_size: 512,
      child_chunk_overlap: 64,
      parent_separator: '\n\n',
      child_separator: '\n',
    })
  })

  it('renders and wires flat controls', () => {
    render(<StatefulSplitterSettingsSection initialConfig={{}} />)

    const chunkSizeInput = screen.getByLabelText('Max Chunk Size')
    const chunkOverlapInput = screen.getByLabelText('Chunk Overlap')
    const separatorInput = screen.getByTestId('flat-separator-input')
    const fileAwareCheckbox = screen.getByTestId('file-aware-checkbox')
    const titleEnhancementCheckbox = screen.getByTestId('title-enhancement-checkbox')

    expect(chunkSizeInput).toHaveValue(1024)
    expect(chunkOverlapInput).toHaveValue(50)
    expect(separatorInput).toHaveValue('\\n\\n')
    expect(separatorInput).toHaveClass('font-mono', 'text-sm')
    expectBefore(chunkSizeInput, chunkOverlapInput)
    expectBefore(chunkOverlapInput, separatorInput)
    expectBefore(separatorInput, fileAwareCheckbox)
    expectBefore(fileAwareCheckbox, titleEnhancementCheckbox)

    fireEvent.change(chunkSizeInput, { target: { value: '2048' } })
    fireEvent.change(chunkOverlapInput, { target: { value: '100' } })
    fireEvent.change(separatorInput, { target: { value: '\\n' } })

    expect(chunkSizeInput).toHaveValue(2048)
    expect(chunkOverlapInput).toHaveValue(100)
    expect(separatorInput).toHaveValue('\\n')
  })

  it('disables title enhancement when file-aware is turned off', () => {
    render(<StatefulSplitterSettingsSection initialConfig={{}} />)

    const fileAwareCheckbox = screen.getByTestId('file-aware-checkbox')
    const titleEnhancementCheckbox = screen.getByTestId('title-enhancement-checkbox')

    expect(fileAwareCheckbox).toBeChecked()
    expect(titleEnhancementCheckbox).toBeChecked()
    expect(titleEnhancementCheckbox).not.toBeDisabled()

    fireEvent.click(fileAwareCheckbox)

    expect(fileAwareCheckbox).not.toBeChecked()
    expect(titleEnhancementCheckbox).not.toBeChecked()
    expect(titleEnhancementCheckbox).toBeDisabled()
  })

  it('disables flat controls in read only mode', () => {
    render(<SplitterSettingsSection config={{}} onChange={jest.fn()} readOnly={true} />)

    expect(screen.getByLabelText('Max Chunk Size')).toBeDisabled()
    expect(screen.getByLabelText('Chunk Overlap')).toBeDisabled()
    expect(screen.getByLabelText('Separator')).toBeDisabled()
  })

  it('shows hierarchical controls only when hierarchical is selected', () => {
    render(<StatefulSplitterSettingsSection initialConfig={{}} />)

    expect(screen.queryByLabelText('Parent chunk size')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Child chunk size')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Child chunk overlap')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Parent separator')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Child separator')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('chunk-strategy-select'), {
      target: { value: 'hierarchical' },
    })

    expect(screen.getByLabelText('Parent chunk size')).toHaveValue(2048)
    expect(screen.getByLabelText('Child chunk size')).toHaveValue(512)
    expect(screen.getByLabelText('Child chunk overlap')).toHaveValue(64)
    const parentSeparatorInput = screen.getByTestId('parent-separator-input')
    const childSeparatorInput = screen.getByTestId('child-separator-input')
    const fileAwareCheckbox = screen.getByTestId('file-aware-checkbox')
    const titleEnhancementCheckbox = screen.getByTestId('title-enhancement-checkbox')

    expect(parentSeparatorInput).toHaveValue('\\n\\n')
    expect(childSeparatorInput).toHaveValue('\\n')
    expect(parentSeparatorInput).toHaveClass('font-mono', 'text-sm')
    expect(childSeparatorInput).toHaveClass('font-mono', 'text-sm')
    expectBefore(
      screen.getByLabelText('Parent chunk size'),
      screen.getByLabelText('Child chunk size')
    )
    expectBefore(
      screen.getByLabelText('Child chunk size'),
      screen.getByLabelText('Child chunk overlap')
    )
    expectBefore(screen.getByLabelText('Child chunk overlap'), parentSeparatorInput)
    expectBefore(parentSeparatorInput, childSeparatorInput)
    expectBefore(childSeparatorInput, fileAwareCheckbox)
    expectBefore(fileAwareCheckbox, titleEnhancementCheckbox)
  })
})
