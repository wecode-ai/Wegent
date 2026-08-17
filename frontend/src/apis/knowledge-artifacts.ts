// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import client from './client'
import type {
  KnowledgeArtifact,
  KnowledgeArtifactCreate,
  KnowledgeArtifactListResponse,
} from '@/types/knowledge-artifact'

const artifactPath = (knowledgeBaseId: number, artifactId?: string) =>
  `/knowledge-bases/${knowledgeBaseId}/artifacts${artifactId ? `/${artifactId}` : ''}`

export const knowledgeArtifactApi = {
  list: (knowledgeBaseId: number) =>
    client.get<KnowledgeArtifactListResponse>(artifactPath(knowledgeBaseId)),

  get: (knowledgeBaseId: number, artifactId: string) =>
    client.get<KnowledgeArtifact>(artifactPath(knowledgeBaseId, artifactId)),

  create: (knowledgeBaseId: number, request: KnowledgeArtifactCreate) =>
    client.post<KnowledgeArtifact>(artifactPath(knowledgeBaseId), request),

  rename: (knowledgeBaseId: number, artifactId: string, title: string) =>
    client.patch<KnowledgeArtifact>(artifactPath(knowledgeBaseId, artifactId), { title }),

  retry: (knowledgeBaseId: number, artifactId: string) =>
    client.post<KnowledgeArtifact>(`${artifactPath(knowledgeBaseId, artifactId)}/retry`),

  delete: (knowledgeBaseId: number, artifactId: string) =>
    client.delete<void>(artifactPath(knowledgeBaseId, artifactId)),
}
