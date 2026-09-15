// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import { adminApis, type AdminPublicModel } from '@/apis/admin'
import PublicModelList from '@/features/admin/components/PublicModelList'

jest.mock('@/hooks/useTranslation', () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})

jest.mock('@/hooks/use-toast', () => {
  const toast = jest.fn()
  return { useToast: () => ({ toast }) }
})

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getPublicModels: jest.fn(),
    createPublicModel: jest.fn(),
    updatePublicModel: jest.fn(),
  },
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const model: AdminPublicModel = {
  id: 1,
  name: 'kimi',
  namespace: 'default',
  display_name: 'Kimi',
  json: {
    kind: 'Model',
    spec: {
      modelGroup: 'Domestic',
      modelSubGroup: 'Kimi',
      modelConfig: { model_id: 'kimi', context_window: 1048576 },
      isVisible: true,
    },
  },
  is_active: true,
  is_visible: true,
  is_advanced: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const mockedAdminApis = jest.mocked(adminApis)

describe.each(['create', 'edit'] as const)('PublicModelList %s grouping synchronization', mode => {
  const openDialog = async () => {
    render(<PublicModelList />)
    if (mode === 'create') {
      fireEvent.click(
        await screen.findByRole('button', { name: 'admin:public_models.create_model' })
      )
      fireEvent.change(screen.getByLabelText('admin:public_models.form.name *'), {
        target: { value: 'new-model' },
      })
    } else {
      fireEvent.click(await screen.findByTitle('admin:public_models.edit_model'))
    }
    return {
      group: screen.getByLabelText('admin:public_models.form.model_group'),
      subGroup: screen.getByLabelText('admin:public_models.form.model_sub_group'),
      config: screen.getByLabelText(/^admin:public_models.form.config/) as HTMLTextAreaElement,
    }
  }

  const saveModel = async () => {
    fireEvent.click(
      screen.getByRole('button', {
        name: mode === 'create' ? 'admin:common.create' : 'admin:common.save',
      })
    )
    if (mode === 'create') {
      await waitFor(() => expect(mockedAdminApis.createPublicModel).toHaveBeenCalledTimes(1))
      return mockedAdminApis.createPublicModel.mock.calls[0][0].json
    }
    await waitFor(() => expect(mockedAdminApis.updatePublicModel).toHaveBeenCalledTimes(1))
    return mockedAdminApis.updatePublicModel.mock.calls[0][1].json
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockedAdminApis.getPublicModels.mockResolvedValue({ items: [model], total: 1 })
    mockedAdminApis.createPublicModel.mockResolvedValue(model)
    mockedAdminApis.updatePublicModel.mockResolvedValue(model)
  })

  it('writes group inputs into JSON immediately and removes cleared groups before saving', async () => {
    const { group, subGroup, config } = await openDialog()
    const originalConfig = JSON.parse(config.value)

    fireEvent.change(group, { target: { value: ' International ' } })
    fireEvent.change(subGroup, { target: { value: 'Claude' } })

    expect(JSON.parse(config.value)).toEqual({
      ...originalConfig,
      spec: { ...originalConfig.spec, modelGroup: 'International', modelSubGroup: 'Claude' },
    })

    fireEvent.change(group, { target: { value: '' } })
    expect(JSON.parse(config.value).spec).not.toHaveProperty('modelGroup')
    expect(JSON.parse(config.value).spec.modelSubGroup).toBe('Claude')

    fireEvent.change(subGroup, { target: { value: '   ' } })
    expect(JSON.parse(config.value).spec).not.toHaveProperty('modelSubGroup')

    expect(await saveModel()).toEqual({
      ...JSON.parse(config.value),
      spec: { ...JSON.parse(config.value).spec, isVisible: true },
    })
  })

  it('reads JSON group edits and deletions without overwriting them on save', async () => {
    const { group, subGroup, config } = await openDialog()
    const changedConfig = {
      ...model.json,
      spec: { modelGroup: 'International', modelSubGroup: 'Claude', isVisible: false },
    }
    const jsonText = JSON.stringify(changedConfig)

    fireEvent.change(config, { target: { value: jsonText } })

    expect(group).toHaveValue('International')
    expect(subGroup).toHaveValue('Claude')
    expect(config).toHaveValue(jsonText)
    expect(screen.getByTestId(`public-model-${mode}-visible-switch`)).toHaveAttribute(
      'data-state',
      'unchecked'
    )

    fireEvent.change(config, {
      target: { value: JSON.stringify({ ...changedConfig, spec: { modelSubGroup: 'Gemini' } }) },
    })
    expect(group).toHaveValue('')
    expect(subGroup).toHaveValue('Gemini')

    expect(await saveModel()).toEqual({
      ...changedConfig,
      spec: { modelSubGroup: 'Gemini', isVisible: false },
    })
  })

  it('preserves invalid JSON and the last valid groups until the configuration is repaired', async () => {
    const { group, subGroup, config } = await openDialog()
    fireEvent.change(config, { target: { value: JSON.stringify(model.json) } })

    for (const invalidConfig of ['{"spec":', '{"spec":null}']) {
      fireEvent.change(config, { target: { value: invalidConfig } })
      fireEvent.change(group, { target: { value: 'Lost edit' } })
      fireEvent.change(subGroup, { target: { value: 'Lost edit' } })

      expect(config).toHaveValue(invalidConfig)
      expect(group).toHaveValue('Domestic')
      expect(subGroup).toHaveValue('Kimi')
      expect(screen.getByText('admin:public_models.errors.config_invalid_json')).toBeInTheDocument()
    }

    fireEvent.click(
      screen.getByRole('button', {
        name: mode === 'create' ? 'admin:common.create' : 'admin:common.save',
      })
    )
    expect(mockedAdminApis.createPublicModel).not.toHaveBeenCalled()
    expect(mockedAdminApis.updatePublicModel).not.toHaveBeenCalled()

    fireEvent.change(config, { target: { value: '{"kind":"Model"}' } })
    expect(group).toHaveValue('')
    expect(subGroup).toHaveValue('')
    expect(
      screen.queryByText('admin:public_models.errors.config_invalid_json')
    ).not.toBeInTheDocument()
  })
})
