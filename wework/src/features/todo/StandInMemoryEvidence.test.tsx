import type { StandInMemory } from '@/api/standIn'
import '@/i18n'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { StandInMemoryEvidence } from './StandInMemoryEvidence'

type EvidenceSource = NonNullable<StandInMemory['evidence']>['source']

function renderEvidence(source: EvidenceSource, kind?: 'image_observation') {
  const memory: StandInMemory = {
    id: 'memory',
    content: 'Stored fact',
    scope: { kind: 'personal' },
    version: 1,
    createdAt: '',
    updatedAt: '',
    evidence: { kind, taskId: 'project:opaque-checkpoint', source, excerpt: 'Original evidence' },
  }
  render(<StandInMemoryEvidence memory={memory} />)
  return screen.getByTestId('stand-in-memory-evidence')
}

it.each([
  [{ projectStore: 'local', fileId: 'file-1' }, '本地项目 project-1 · 项目文件 file-1'],
  [
    { projectStore: 'cloud', itemId: 'ISSUE-2', attachmentId: 'attachment-3' },
    '云端项目 project-1 · Issue ISSUE-2 · Issue 附件 attachment-3',
  ],
  [
    { projectStore: 'local', itemId: 'ISSUE-2', deliveryId: 'delivery-4', assetId: 'asset-5' },
    '本地项目 project-1 · Issue ISSUE-2 · 交付 delivery-4 · 交付文件 asset-5',
  ],
  [{ itemId: null, deliveryId: null }, '项目 project-1'],
] satisfies [EvidenceSource, string][])(
  'shows persisted project source identifiers: %j',
  (source, label) => {
    const evidence = renderEvidence({ ...source, projectId: 'project-1' })
    expect(evidence).toHaveTextContent(label)
    expect(evidence).not.toHaveTextContent('opaque-checkpoint')
    expect(evidence).not.toHaveTextContent('null')
    expect(evidence).toHaveTextContent('Original evidence')
    expect(evidence).not.toHaveAttribute('open')
  }
)

it('preserves named connector sources and treats their labels as plain text', () => {
  const evidence = renderEvidence({ id: 'source-1', name: '<img src=x onerror=alert(1)>' })
  expect(evidence).toHaveTextContent('<img src=x onerror=alert(1)>')
  expect(evidence.querySelector('img')).toBeNull()
})

it('keeps the original identifier when older evidence has no structured source', () => {
  expect(renderEvidence(undefined)).toHaveTextContent('project:opaque-checkpoint')
})

it('labels model image interpretations and does not render them as source quotations', () => {
  const evidence = renderEvidence(undefined, 'image_observation')
  expect(evidence).toHaveTextContent('AI 图片解读（非原文核验，可能有误）')
  expect(evidence).toHaveTextContent('Original evidence')
  expect(evidence.querySelector('blockquote')).toBeNull()
})
