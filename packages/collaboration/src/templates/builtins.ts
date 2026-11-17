// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import definitions from '../../../../shared/data/collaboration-templates.json'
import englishDefinitions from './builtins.en.json'
import type { CollaborationLocale } from '../i18n'
import { validateTemplate } from './document'
import type { TemplateRecord } from './types'

/** The backend seeds exactly these identities and versions into Kind. */
export function builtinCollaborationTemplates(): TemplateRecord[] {
  return definitions.map(document => ({
    id: null,
    ownerId: 0,
    document: validateTemplate(document),
    revision: null,
    source: 'builtin',
  }))
}

const englishBuiltins = englishDefinitions.map(document => validateTemplate(document))

/** Localize only the known first-party release, without changing stored records. */
export function localizeBuiltinTemplateRecord(
  record: TemplateRecord,
  locale: CollaborationLocale
): TemplateRecord {
  if (
    locale !== 'en' ||
    record.source === 'personal' ||
    record.ownerId !== 0 ||
    record.document.metadata.namespace !== 'system'
  )
    return record
  const document = englishBuiltins.find(
    candidate =>
      candidate.metadata.name === record.document.metadata.name &&
      candidate.spec.version === record.document.spec.version
  )
  return document ? { ...record, document: structuredClone(document) } : record
}
