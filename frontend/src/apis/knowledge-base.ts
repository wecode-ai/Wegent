// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeBasesResponse } from '@/types/api';
import client from './client';

export const knowledgeBaseApi = {
  /**
   * List all knowledge bases accessible to the user
   */
  list: async (params?: {
    scope?: string;
    group_name?: string;
  }): Promise<KnowledgeBasesResponse> => {
    const queryParams = new URLSearchParams();
    if (params?.scope) queryParams.append('scope', params.scope);
    if (params?.group_name) queryParams.append('group_name', params.group_name);

    const queryString = queryParams.toString();
    // Use the correct endpoint from /api/knowledge-bases
    const url = `/knowledge-bases${queryString ? `?${queryString}` : ''}`;

    const response = await client.get<KnowledgeBasesResponse>(url);
    return response;
  },
};
