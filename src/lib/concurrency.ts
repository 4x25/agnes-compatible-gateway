/**
 * Runs `count` jobs with a bounded number of in-flight tasks, preserving result order.
 * The first failure aborts the remaining jobs and rejects the whole batch (atomic semantics).
 */
export async function mapWithConcurrency<T>(
  count: number,
  limit: number,
  worker: (index: number, signal: AbortSignal) => Promise<T>
): Promise<T[]> {
  const results: T[] = new Array(count)
  const controller = new AbortController()
  let firstError: unknown = null
  let cursor = 0

  const runner = async (): Promise<void> => {
    while (true) {
      if (firstError) return
      const index = cursor++
      if (index >= count) return
      try {
        results[index] = await worker(index, controller.signal)
      } catch (error) {
        if (!firstError) {
          firstError = error
          controller.abort()
        }
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, count) }, runner))
  if (firstError) throw firstError
  return results
}
