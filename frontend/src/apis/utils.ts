// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from './client';

export interface UrlMetadataResponse {
  url: string;
  title: string | null;
  description: string | null;
  favicon: string | null;
  success: boolean;
}

/**
 * Fetch metadata for a URL (title, description, favicon)
 * @param url - The URL to fetch metadata for
 * @returns Promise resolving to URL metadata
 */
export async function fetchUrlMetadata(url: string): Promise<UrlMetadataResponse> {
  const encodedUrl = encodeURIComponent(url);
  return apiClient.get<UrlMetadataResponse>(`/utils/url-metadata?url=${encodedUrl}`);
}
