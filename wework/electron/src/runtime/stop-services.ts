/** Stop every owner before reporting failures; a partial shutdown must not authorize an update. */
export async function stopServices(
  services: { name: string; stop: () => Promise<void> | undefined }[]
): Promise<void> {
  const results = await Promise.allSettled(services.map(async service => service.stop()))
  const errors = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [new Error(`Failed to stop ${services[index].name}`, { cause: result.reason })]
      : []
  )
  if (errors.length) throw new AggregateError(errors, 'Application services failed to stop')
}
