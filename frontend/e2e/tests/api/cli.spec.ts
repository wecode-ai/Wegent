import { test, expect } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'
import { buildCliTeamResource, parseCliJson, runWegentCli } from '../../utils/cli'
import { createApiClient } from '../../utils/api-client'

test.describe('CLI API E2E', () => {
  let token: string
  let createdTeamName: string | null = null

  test.beforeEach(async ({ request }) => {
    const apiClient = createApiClient(request)
    const loginResponse = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)

    expect(loginResponse.status).toBe(200)
    expect(loginResponse.data?.access_token).toEqual(expect.any(String))
    token = loginResponse.data!.access_token
  })

  test.afterEach(async () => {
    if (!createdTeamName) {
      return
    }

    await runWegentCli(['kind', 'delete', 'team', createdTeamName, '--json'], {
      token,
    }).catch(() => {})
    createdTeamName = null
  })

  test('lists teams from the real backend', async () => {
    const result = await runWegentCli(['kind', 'get', 'teams', '--json'], {
      token,
    })
    const envelope = parseCliJson<{
      kind: string
      items: Array<{ metadata?: { name?: string } }>
    }>(result)

    expect(result.exitCode, result.stderr || result.stdout).toBe(0)
    expect(envelope.success).toBe(true)
    expect(envelope.data.kind).toBe('TeamList')
    expect(Array.isArray(envelope.data.items)).toBe(true)
  })

  test('applies, reads, and deletes a team through the real backend', async ({}, testInfo) => {
    const teamName = `e2e-cli-api-${testInfo.workerIndex}-${Date.now()}`
    const teamResource = buildCliTeamResource(teamName)
    createdTeamName = teamName

    const applyResult = await runWegentCli(['kind', 'apply', '--input', '-', '--json'], {
      token,
      stdin: JSON.stringify(teamResource),
    })
    const applyEnvelope = parseCliJson<{
      success: boolean
      results: Array<{ success: boolean; name: string; kind: string }>
    }>(applyResult)

    expect(applyResult.exitCode, applyResult.stderr || applyResult.stdout).toBe(0)
    expect(applyEnvelope.success).toBe(true)
    expect(applyEnvelope.data.success).toBe(true)
    expect(applyEnvelope.data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          success: true,
          kind: 'Team',
          name: teamName,
        }),
      ])
    )

    const getResult = await runWegentCli(['kind', 'get', 'team', teamName, '--json'], {
      token,
    })
    const getEnvelope = parseCliJson<{ kind: string; metadata: { name: string } }>(getResult)

    expect(getResult.exitCode, getResult.stderr || getResult.stdout).toBe(0)
    expect(getEnvelope.success).toBe(true)
    expect(getEnvelope.data.kind).toBe('Team')
    expect(getEnvelope.data.metadata.name).toBe(teamName)

    const deleteResult = await runWegentCli(['kind', 'delete', 'team', teamName, '--json'], {
      token,
    })
    const deleteEnvelope = parseCliJson<{ message: string }>(deleteResult)

    expect(deleteResult.exitCode, deleteResult.stderr || deleteResult.stdout).toBe(0)
    expect(deleteEnvelope.success).toBe(true)
    expect(deleteEnvelope.data.message).toContain(teamName)
    createdTeamName = null
  })
})
