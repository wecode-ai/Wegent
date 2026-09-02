interface ApplicationPackagingEnvironment {
  WEWORK_APP_HOT_RELOAD?: string
}

export function isEffectivePackagedApplication(
  electronReportsPackaged: boolean,
  environment: ApplicationPackagingEnvironment
): boolean {
  return electronReportsPackaged && environment.WEWORK_APP_HOT_RELOAD !== '1'
}
