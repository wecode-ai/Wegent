// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationProject } from '@wegent/collaboration'
import { createPersonalIssuesApi } from '@wegent/collaboration/platform'
import { apiClient } from '@/apis/client'

export const webPersonalIssuesApi = createPersonalIssuesApi<CollaborationProject>({
  get: (endpoint, options) => apiClient.get(endpoint, options),
  getBlob: endpoint => apiClient.getBlob(endpoint),
  post: (endpoint, input) =>
    input instanceof FormData
      ? apiClient.postForm(endpoint, input)
      : apiClient.post(endpoint, input),
  patch: (endpoint, input) => apiClient.patch(endpoint, input),
  delete: (endpoint, input) => apiClient.delete(endpoint, input),
})
