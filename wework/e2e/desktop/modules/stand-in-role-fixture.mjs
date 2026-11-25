export function standInRoleFixture(executionDeviceId, id = 'default') {
  return {
    id,
    name: '',
    enabled: false,
    prompt: '',
    executionDeviceId,
    version: 0,
    tags: [],
    collaboration: {
      enabled: false,
      allProjects: true,
      projects: [],
      excludedProjects: [],
      tags: [],
    },
  }
}

export async function seedStandInRoleFixture(rpc, userId) {
  const settings = await rpc('runtime.stand_in.personal.get', { userId })
  if (settings.roles.some(role => role.id === 'default')) return settings
  return rpc('runtime.stand_in.personal.save', {
    userId,
    settings: {
      ...settings,
      roles: [...settings.roles, standInRoleFixture(settings.executionDeviceId)],
    },
  })
}
