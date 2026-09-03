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
      isWeworkAvailable: false,
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

  it('applies grouping fields only when saving', async () => {
    const { group, subGroup, config } = await openDialog()
    const originalConfig = JSON.parse(config.value)

    fireEvent.change(group, { target: { value: ' International ' } })
    fireEvent.change(subGroup, { target: { value: 'Claude' } })

    expect(JSON.parse(config.value)).toEqual(originalConfig)
    expect(await saveModel()).toEqual({
      ...originalConfig,
      spec: {
        ...(originalConfig.spec ?? {}),
        modelGroup: 'International',
        modelSubGroup: 'Claude',
        isVisible: true,
      },
    })
  })

  it('removes cleared grouping fields when saving', async () => {
    const { group, subGroup, config } = await openDialog()
    const originalConfig = JSON.parse(config.value)

    fireEvent.change(group, { target: { value: '' } })
    fireEvent.change(subGroup, { target: { value: '   ' } })

    const savedConfig = await saveModel()
    const {
      modelGroup: _modelGroup,
      modelSubGroup: _modelSubGroup,
      ...expectedSpec
    } = originalConfig.spec ?? {}

    expect(savedConfig).toEqual({
      ...originalConfig,
      spec: { ...expectedSpec, isVisible: true },
    })
    expect((savedConfig as Record<string, { modelGroup?: string }>).spec).not.toHaveProperty(
      'modelGroup'
    )
    expect((savedConfig as Record<string, { modelSubGroup?: string }>).spec).not.toHaveProperty(
      'modelSubGroup'
    )
  })

  it('keeps invalid JSON unsaved', async () => {
    const { config } = await openDialog()

    fireEvent.change(config, { target: { value: '{"spec":' } })
    fireEvent.click(
      screen.getByRole('button', {
        name: mode === 'create' ? 'admin:common.create' : 'admin:common.save',
      })
    )

    expect(mockedAdminApis.createPublicModel).not.toHaveBeenCalled()
    expect(mockedAdminApis.updatePublicModel).not.toHaveBeenCalled()
    expect(screen.getByText('admin:public_models.errors.config_invalid_json')).toBeInTheDocument()
  })
})

it('resets edit form values before creating a model', async () => {
  render(<PublicModelList />)

  fireEvent.click(await screen.findByTitle('admin:public_models.edit_model'))
  fireEvent.change(screen.getByLabelText('admin:public_models.form.model_group'), {
    target: { value: 'International' },
  })
  fireEvent.change(screen.getByLabelText('admin:public_models.form.model_sub_group'), {
    target: { value: 'Claude' },
  })
  fireEvent.click(screen.getByTestId('public-model-edit-visible-switch'))
  fireEvent.click(screen.getByRole('button', { name: 'admin:common.cancel' }))

  fireEvent.click(screen.getByRole('button', { name: 'admin:public_models.create_model' }))
  fireEvent.change(screen.getByLabelText('admin:public_models.form.name *'), {
    target: { value: 'new-model' },
  })

  expect(screen.getByLabelText('admin:public_models.form.model_group')).toHaveValue('')
  expect(screen.getByLabelText('admin:public_models.form.model_sub_group')).toHaveValue('')
  expect(screen.getByTestId('public-model-create-visible-switch')).toHaveAttribute(
    'data-state',
    'checked'
  )

  fireEvent.click(screen.getByRole('button', { name: 'admin:common.create' }))

  await waitFor(() => expect(mockedAdminApis.createPublicModel).toHaveBeenCalledTimes(1))
  expect(mockedAdminApis.createPublicModel.mock.calls[0][0].json).toEqual({
    spec: { isVisible: true },
  })
})

it('preserves explicit unavailable state when editing without changes', async () => {
  render(<PublicModelList />)

  fireEvent.click(await screen.findByTitle('admin:public_models.edit_model'))
  fireEvent.click(screen.getByRole('button', { name: 'admin:common.save' }))

  await waitFor(() => expect(mockedAdminApis.updatePublicModel).toHaveBeenCalledTimes(1))
  expect(mockedAdminApis.updatePublicModel.mock.calls[0][1].json).toEqual(model.json)
})
