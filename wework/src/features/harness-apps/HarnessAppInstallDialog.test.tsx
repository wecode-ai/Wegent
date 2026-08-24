import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { HarnessAppPreview } from '@/api/local/harnessApps'
import { HarnessAppInstallDialog } from './HarnessAppInstallDialog'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

const preview: HarnessAppPreview = {
  valid: true,
  archivePath: '/tmp/dsh-ops-text-classifier.zip',
  sha256: 'hash',
  issues: [],
  manifest: {
    name: 'dsh-ops-text-classifier',
    displayName: 'DSH 运营文本分类工作台',
    version: '0.1.0-rc.8',
    type: 'deepseek-harness-plugin-bundle',
    description: '对运营文本进行分类',
    entry: {
      installPackage: 'packages/bundle/ops-app',
      profile: 'ops',
      webUrl: 'http://127.0.0.1:3080/',
    },
    requirements: {
      dsh: '0.1.0-rc.8',
      node: '>=22',
    },
  },
}

const modelOptions = [
  {
    key: 'wework:model-1',
    label: 'Wework Model',
    model: {
      name: 'model-1',
      type: 'runtime' as const,
      provider: 'local',
      displayName: 'Wework Model',
      modelId: 'upstream-model-1',
      config: {},
    },
  },
]

describe('HarnessAppInstallDialog', () => {
  test('shows package requirements and installs with the selected model', () => {
    const onInstall = vi.fn()
    const onModelChange = vi.fn()

    render(
      <HarnessAppInstallDialog
        busy={false}
        error={null}
        modelKey={modelOptions[0].key}
        modelOptions={modelOptions}
        preview={preview}
        onCancel={vi.fn()}
        onChooseAnother={vi.fn()}
        onInstall={onInstall}
        onModelChange={onModelChange}
      />
    )

    expect(screen.getByText('DSH 运营文本分类工作台')).toBeInTheDocument()
    expect(screen.getByText('0.1.0-rc.8')).toBeInTheDocument()
    expect(screen.getByText('>=22')).toBeInTheDocument()
    expect(screen.getByTestId('harness-app-install-backdrop')).toBeInTheDocument()
    expect(screen.getByTestId('harness-app-install-close')).toBeInTheDocument()
    expect(screen.getByTestId('harness-app-choose-another')).toBeInTheDocument()
    expect(screen.getByTestId('harness-app-install-cancel')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('harness-app-model-select'), {
      target: { value: modelOptions[0].key },
    })
    fireEvent.click(screen.getByTestId('harness-app-install-confirm'))

    expect(onModelChange).toHaveBeenCalledWith(modelOptions[0].key)
    expect(onInstall).toHaveBeenCalledOnce()
  })

  test('shows validation issues without exposing an install action', () => {
    render(
      <HarnessAppInstallDialog
        busy={false}
        error={null}
        modelKey=""
        modelOptions={modelOptions}
        preview={{
          ...preview,
          valid: false,
          manifest: null,
          issues: ['plugin-manifest.json 缺失'],
        }}
        onCancel={vi.fn()}
        onChooseAnother={vi.fn()}
        onInstall={vi.fn()}
        onModelChange={vi.fn()}
      />
    )

    expect(screen.getByText('无法安装这个智能工作台')).toBeInTheDocument()
    expect(screen.getByText('plugin-manifest.json 缺失')).toBeInTheDocument()
    expect(screen.queryByTestId('harness-app-install-confirm')).not.toBeInTheDocument()
  })
})
