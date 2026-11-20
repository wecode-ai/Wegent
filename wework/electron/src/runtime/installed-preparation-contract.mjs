export const INSTALLED_PREPARATION_ARGUMENT = '--wework-prepare-installation'
export const INSTALLED_PREPARATION_PROGRESS_PREFIX = '[install-preparation-stage] '

export function isInstalledPreparationRequest(argv) {
  return argv.includes(INSTALLED_PREPARATION_ARGUMENT)
}
