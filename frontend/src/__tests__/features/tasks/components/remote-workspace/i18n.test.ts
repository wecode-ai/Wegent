// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import enTasks from '@/i18n/locales/en/tasks.json'
import zhTasks from '@/i18n/locales/zh-CN/tasks.json'

type RemoteWorkspaceTranslations = {
  button?: string
  unavailable?: string
  title?: string
  root?: string
  parent?: string
  parent_entry?: string
  parent_entry_hint?: string
  search_placeholder?: string
  sort?: {
    label?: string
    options?: {
      name_asc?: string
      name_desc?: string
      size_desc?: string
      modified_desc?: string
    }
  }
  actions?: {
    download?: string
    refresh?: string
  }
  download_confirm?: {
    title?: string
    description?: string
  }
  columns?: {
    select_all?: string
    name?: string
    size?: string
    modified?: string
    type?: string
  }
  status?: {
    path?: string
    selected?: string
    items?: string
    has_files?: string
  }
  detail?: {
    title?: string
    no_file_selected?: string
    multiple_selected?: string
    metadata?: string
    metadata_path?: string
    metadata_size?: string
    metadata_modified?: string
    metadata_type?: string
  }
  preview?: {
    empty?: string
    loading?: string
    load_failed?: string
    unsupported?: string
  }
  tree?: {
    title?: string
    expand?: string
    collapse?: string
    open_directory?: string
    loading?: string
    loading_children?: string
    empty?: string
    load_failed?: string
    load_children_failed?: string
    retry?: string
  }
}

function assertRemoteWorkspaceKeys(locale: RemoteWorkspaceTranslations) {
  expect(locale.button).toBeTruthy()
  expect(locale.unavailable).toBeTruthy()
  expect(locale.title).toBeTruthy()
  expect(locale.root).toBeTruthy()
  expect(locale.parent).toBeTruthy()
  expect(locale.parent_entry).toBeTruthy()
  expect(locale.parent_entry_hint).toBeTruthy()
  expect(locale.search_placeholder).toBeTruthy()
  expect(locale.sort?.label).toBeTruthy()
  expect(locale.sort?.options?.name_asc).toBeTruthy()
  expect(locale.sort?.options?.name_desc).toBeTruthy()
  expect(locale.sort?.options?.size_desc).toBeTruthy()
  expect(locale.sort?.options?.modified_desc).toBeTruthy()
  expect(locale.actions?.download).toBeTruthy()
  expect(locale.actions?.refresh).toBeTruthy()
  expect(locale.download_confirm?.title).toBeTruthy()
  expect(locale.download_confirm?.description).toBeTruthy()
  expect(locale.columns?.select_all).toBeTruthy()
  expect(locale.columns?.name).toBeTruthy()
  expect(locale.columns?.size).toBeTruthy()
  expect(locale.columns?.modified).toBeTruthy()
  expect(locale.columns?.type).toBeTruthy()
  expect(locale.status?.path).toBeTruthy()
  expect(locale.status?.selected).toBeTruthy()
  expect(locale.status?.items).toBeTruthy()
  expect(locale.status?.has_files).toBeTruthy()
  expect(locale.detail?.title).toBeTruthy()
  expect(locale.detail?.no_file_selected).toBeTruthy()
  expect(locale.detail?.multiple_selected).toBeTruthy()
  expect(locale.detail?.metadata).toBeTruthy()
  expect(locale.detail?.metadata_path).toBeTruthy()
  expect(locale.detail?.metadata_size).toBeTruthy()
  expect(locale.detail?.metadata_modified).toBeTruthy()
  expect(locale.detail?.metadata_type).toBeTruthy()
  expect(locale.preview?.empty).toBeTruthy()
  expect(locale.preview?.loading).toBeTruthy()
  expect(locale.preview?.load_failed).toBeTruthy()
  expect(locale.preview?.unsupported).toBeTruthy()
  expect(locale.tree?.title).toBeTruthy()
  expect(locale.tree?.expand).toBeTruthy()
  expect(locale.tree?.collapse).toBeTruthy()
  expect(locale.tree?.open_directory).toBeTruthy()
  expect(locale.tree?.loading).toBeTruthy()
  expect(locale.tree?.loading_children).toBeTruthy()
  expect(locale.tree?.empty).toBeTruthy()
  expect(locale.tree?.load_failed).toBeTruthy()
  expect(locale.tree?.load_children_failed).toBeTruthy()
  expect(locale.tree?.retry).toBeTruthy()
}

describe('remote workspace i18n', () => {
  test('has remote workspace translation keys in zh-CN and en', () => {
    assertRemoteWorkspaceKeys(
      (enTasks as Record<string, unknown>).remote_workspace as RemoteWorkspaceTranslations
    )
    assertRemoteWorkspaceKeys(
      (zhTasks as Record<string, unknown>).remote_workspace as RemoteWorkspaceTranslations
    )
  })
})
