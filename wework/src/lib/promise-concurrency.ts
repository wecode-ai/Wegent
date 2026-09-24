export async function allSettledWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input, index: number) => Promise<Output>
): Promise<PromiseSettledResult<Output>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Concurrency must be a positive integer')
  }

  const results = new Array<PromiseSettledResult<Output>>(inputs.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < inputs.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = {
          status: 'fulfilled',
          value: await operation(inputs[index], index),
        }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()))
  return results
}
