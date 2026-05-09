// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import enAdmin from '@/i18n/locales/en/admin.json'
import zhAdmin from '@/i18n/locales/zh-CN/admin.json'

type PublicSkillTranslations = {
  hidden?: string
  edit_metadata_title?: string
  edit_metadata_description?: string
  fields?: {
    description?: string
    version?: string
    author?: string
    tags?: string
    visible?: string
  }
  placeholders?: {
    description?: string
    version?: string
    author?: string
    tags?: string
  }
  hints?: {
    tags?: string
    visible?: string
  }
}

function assertPublicSkillMetadataKeys(locale: PublicSkillTranslations) {
  expect(locale.hidden).toBeTruthy()
  expect(locale.edit_metadata_title).toBeTruthy()
  expect(locale.edit_metadata_description).toBeTruthy()
  expect(locale.fields?.description).toBeTruthy()
  expect(locale.fields?.version).toBeTruthy()
  expect(locale.fields?.author).toBeTruthy()
  expect(locale.fields?.tags).toBeTruthy()
  expect(locale.fields?.visible).toBeTruthy()
  expect(locale.placeholders?.description).toBeTruthy()
  expect(locale.placeholders?.version).toBeTruthy()
  expect(locale.placeholders?.author).toBeTruthy()
  expect(locale.placeholders?.tags).toBeTruthy()
  expect(locale.hints?.tags).toBeTruthy()
  expect(locale.hints?.visible).toBeTruthy()
}

describe('public skill i18n', () => {
  test('has metadata editor translation keys in zh-CN and en', () => {
    assertPublicSkillMetadataKeys(
      (enAdmin as Record<string, unknown>).public_skills as PublicSkillTranslations
    )
    assertPublicSkillMetadataKeys(
      (zhAdmin as Record<string, unknown>).public_skills as PublicSkillTranslations
    )
  })
})
