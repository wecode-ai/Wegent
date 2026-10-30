// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'

export class PartialTemplateApplyError extends Error {}

/** Stop at the first failure and distinguish an untouched project from partial work. */
export async function applyTemplateGroups<T>(
  drafts: ProjectCreateCollaborationGroupDraft[],
  create: (draft: ProjectCreateCollaborationGroupDraft) => Promise<T>,
  partialMessage: string
): Promise<T[]> {
  const created: T[] = []
  try {
    for (const draft of drafts) created.push(await create(draft))
  } catch (error) {
    if (created.length) throw new PartialTemplateApplyError(partialMessage)
    throw error
  }
  return created
}
