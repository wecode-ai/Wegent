// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import client from './client'
import type { AttachmentResponse } from './attachments'

export interface WebContentCrawlResponse {
  attachments: AttachmentResponse[]
}

export const webContentApi = {
  crawl: async (url: string): Promise<WebContentCrawlResponse> => {
    return client.post<WebContentCrawlResponse>('/web-content/crawl', { url })
  },
}
