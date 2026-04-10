// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import { SplitterSettingsSection } from '@/features/knowledge/document/components/SplitterSettingsSection'
import type { SplitterConfig } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'knowledge:document.splitter.type': 'Chunking Type',
        'knowledge:document.splitter.flat': 'Flat',
        'knowledge:document.splitter.hierarchical': 'Hierarchical',
        'knowledge:document.splitter.semantic': 'Semantic',
        'knowledge:document.splitter.formatEnhancement': 'Format enhancement',
        'knowledge:document.splitter.none': 'None',
        'knowledge:document.splitter.fileAware': 'File-aware',
        'knowledge:document.splitter.titleEnhancement': 'Title enhancement',
        'knowledge:document.splitter.parentChunkSize': 'Parent chunk size',
        'knowledge:document.splitter.childChunkSize': 'Child chunk size',
        'knowledge:document.splitter.childChunkOverlap': 'Child chunk overlap',
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
  }: {
    id?: string
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
    disabled?: boolean
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onCheckedChange?.(event.target.checked)}
    />
  ),
}))

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
    expect(screen.getByTestId('format-enhancement-select')).toHaveValue('file_aware')
    expect(screen.getByLabelText('Title enhancement')).toBeChecked()
  })

  it('maps legacy smart config to the new display model', () => {
    render(
      <SplitterSettingsSection config={{ type: 'smart' } as SplitterConfig} onChange={jest.fn()} />
    )

    expect(screen.getByTestId('chunk-strategy-select')).toHaveValue('flat')
    expect(screen.getByTestId('format-enhancement-select')).toHaveValue('file_aware')
    expect(screen.getByLabelText('Title enhancement')).toBeChecked()
  })

  it('shows hierarchical controls only when hierarchical is selected', () => {
    render(<StatefulSplitterSettingsSection initialConfig={{}} />)

    expect(screen.queryByLabelText('Parent chunk size')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Child chunk size')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Child chunk overlap')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('chunk-strategy-select'), {
      target: { value: 'hierarchical' },
    })

    expect(screen.getByLabelText('Parent chunk size')).toBeInTheDocument()
    expect(screen.getByLabelText('Child chunk size')).toBeInTheDocument()
    expect(screen.getByLabelText('Child chunk overlap')).toBeInTheDocument()
  })
})
