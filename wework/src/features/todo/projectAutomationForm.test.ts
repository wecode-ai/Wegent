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
  it('normalizes every executor mode to its exact API contract', () => {
    const projectRobot = buildAutomationInput(
      { ...draftWithAllExecutorFields(), executorType: 'project_robot' },
      schedule,
      {}
    )
    const custom = buildAutomationInput(
      { ...draftWithAllExecutorFields(), executorType: 'custom' },
      schedule,
      {}
    )
    const wegentRobot = buildAutomationInput(
      { ...draftWithAllExecutorFields(), executorType: 'wegent_robot' },
      schedule,
      {}
    )

    expect(projectRobot).toMatchObject({
      executorType: 'project_robot',
      agentId: 'project-agent',
      wegentTeamId: null,
      model: null,
      executionEnvironment: null,
      executionDeviceId: null,
    })
    expect(custom).toMatchObject({
      executorType: 'custom',
      agentId: null,
      wegentTeamId: null,
      model: 'gpt-5-codex',
      executionEnvironment: 'cloud',
      executionDeviceId: 'remote-device',
    })
    expect(wegentRobot).toMatchObject({
      executorType: 'wegent_robot',
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
