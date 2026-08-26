import { describe, expect, it } from 'vitest'
import type { DeviceInfo, UnifiedModel } from '@/types/api'
import {
  buildAutomationInput,
  defaultInput,
  executionEnvironmentForDevice,
  modelSupportsEnvironment,
} from './projectAutomationForm'

const schedule = { frequency: 'daily', time: '03:00', weekday: '1' } as const

function draftWithAllExecutorFields() {
  return {
    ...defaultInput('Handle the new task'),
    name: 'Board management',
    agentId: 'project-agent',
    wegentTeamId: 42,
    model: 'gpt-5-codex',
    executionEnvironment: 'cloud' as const,
    executionDeviceId: 'remote-device',
  }
}

describe('projectAutomationForm', () => {
  it('normalizes manual assignment and both AI manager sources', () => {
    const projectRobot = buildAutomationInput(
      { ...draftWithAllExecutorFields(), assignmentMode: 'manual', managerType: null },
      schedule,
      {}
    )
    const custom = buildAutomationInput(
      {
        ...draftWithAllExecutorFields(),
        assignmentMode: 'ai_managed',
        managerType: 'custom',
        runtimeSource: 'fixed_profile',
        runtimeProfileId: 'runtime-profile',
      },
      schedule,
      {}
    )
    const wegentRobot = buildAutomationInput(
      {
        ...draftWithAllExecutorFields(),
        assignmentMode: 'ai_managed',
        managerType: 'wegent',
      },
      schedule,
      {}
    )

    expect(projectRobot).toMatchObject({
      assignmentMode: 'manual',
      managerType: null,
      agentId: 'project-agent',
      wegentTeamId: null,
      model: null,
      executionEnvironment: null,
      executionDeviceId: null,
    })
    expect(custom).toMatchObject({
      assignmentMode: 'ai_managed',
      managerType: 'custom',
      agentId: null,
      wegentTeamId: null,
      runtimeSource: 'fixed_profile',
      runtimeProfileId: 'runtime-profile',
      model: null,
      executionEnvironment: null,
      executionDeviceId: null,
    })
    expect(wegentRobot).toMatchObject({
      assignmentMode: 'ai_managed',
      managerType: 'wegent',
      agentId: null,
      wegentTeamId: 42,
      model: null,
      executionEnvironment: null,
      executionDeviceId: null,
    })
  })

  it('maps only explicit WeWork local and cloud device types', () => {
    const device = (deviceType: string): DeviceInfo => ({
      id: 1,
      device_id: 'device',
      name: 'Device',
      status: 'online',
      is_default: false,
      device_type: deviceType,
    })

    expect(executionEnvironmentForDevice(device('local'))).toBe('local')
    expect(executionEnvironmentForDevice(device('app'))).toBe('local')
    expect(executionEnvironmentForDevice(device('cloud'))).toBe('cloud')
    expect(executionEnvironmentForDevice(device('remote'))).toBe('cloud')
    expect(executionEnvironmentForDevice(device('managed'))).toBeNull()
  })

  it('does not offer local runtime models for cloud execution', () => {
    const runtimeModel = { name: 'runtime', type: 'runtime' } as UnifiedModel
    const publicModel = { name: 'public', type: 'public' } as UnifiedModel

    expect(modelSupportsEnvironment(runtimeModel, 'local')).toBe(true)
    expect(modelSupportsEnvironment(runtimeModel, 'cloud')).toBe(false)
    expect(modelSupportsEnvironment(publicModel, 'cloud')).toBe(true)
  })
})
