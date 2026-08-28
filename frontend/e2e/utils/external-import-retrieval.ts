import { expect, type APIRequestContext } from '@playwright/test'
import type { RetrievalConfigDraft } from '../../src/types/knowledge'
import { ADMIN_USER } from '../config/test-users'
import { createApiClient, createBackendRequestHeaders } from './api-client'
import { E2E_EMBEDDING_DIMENSIONS } from './mock-embedding'
import { PROVIDER_NATIVE_API_URL, PROVIDER_NATIVE_MOCK_URL } from './provider-native-test-support'

/** One real vector store and model configuration per suite, isolated KBs per case. */
export async function createExternalImportRetrieval(request: APIRequestContext) {
  const runtimeUrl = process.env.E2E_KNOWLEDGE_RUNTIME_URL || 'http://localhost:8200'
  const health = await request.get(`${runtimeUrl}/internal/rag/health`)
  expect(health.ok(), 'Knowledge Runtime must be running for remote import E2E').toBeTruthy()
  const login = await createApiClient(request).login(ADMIN_USER.username, ADMIN_USER.password)
  const token = login.data?.access_token || ''
  expect(token).toBeTruthy()
  const headers = createBackendRequestHeaders(token)
  const name = `e2e-import-rag-${Date.now()}`
  const modelPath = `/api/v1/namespaces/default/models/${name}`
  const retrieverPath = `/api/retrievers/${name}`
  const createdPaths: string[] = []
  const cleanup = async (cleanupRequest: APIRequestContext) => {
    for (const path of [...createdPaths].reverse()) {
      const result = await cleanupRequest.delete(`${PROVIDER_NATIVE_API_URL}${path}`, { headers })
      expect(result.ok(), await result.text()).toBeTruthy()
    }
  }
  try {
    const connection = await request.post(
      `${PROVIDER_NATIVE_API_URL}/api/retrievers/test-connection`,
      {
        headers,
        data: {
          storage_type: 'qdrant',
          url: process.env.E2E_QDRANT_URL || 'http://localhost:6333',
        },
      }
    )
    expect(connection.ok(), await connection.text()).toBeTruthy()
    expect(
      (await connection.json()).success,
      'Qdrant must be reachable before creating fixtures'
    ).toBe(true)

    const model = await request.post(
      `${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/models`,
      {
        headers,
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: { name, namespace: 'default' },
          spec: {
            modelType: 'embedding',
            protocol: 'custom',
            embeddingConfig: { dimensions: E2E_EMBEDDING_DIMENSIONS, encoding_format: 'float' },
            modelConfig: {
              env: {
                model: 'custom',
                model_id: 'e2e-embedding',
                base_url: `${PROVIDER_NATIVE_MOCK_URL}/v1/embeddings`,
              },
            },
          },
        },
      }
    )
    expect(model.ok(), await model.text()).toBeTruthy()
    createdPaths.push(modelPath)
    const retriever = await request.post(`${PROVIDER_NATIVE_API_URL}/api/retrievers`, {
      headers,
      data: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Retriever',
        metadata: { name, namespace: 'default' },
        spec: {
          storageConfig: {
            type: 'qdrant',
            url: process.env.E2E_QDRANT_URL || 'http://localhost:6333',
            indexStrategy: { mode: 'per_dataset' },
          },
          retrievalMethods: { vector: { enabled: true } },
        },
      },
    })
    expect(retriever.ok(), await retriever.text()).toBeTruthy()
    createdPaths.push(retrieverPath)
  } catch (error) {
    await cleanup(request)
    throw error
  }
  const config: RetrievalConfigDraft = {
    retriever_name: name,
    retriever_namespace: 'default',
    embedding_config: { model_name: name, model_namespace: 'default' },
    retrieval_mode: 'vector',
  }
  return { config, cleanup }
}
