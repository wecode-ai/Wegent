// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import definitions from '../../../../shared/data/collaboration-templates.json'
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
