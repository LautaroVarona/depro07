/** Cast helpers for node:sqlite row results under strict TS. */
export function rows<T>(value: unknown): T[] {
  return value as T[]
}

export function row<T>(value: unknown): T | undefined {
  return value as T | undefined
}

export function rowRequired<T>(value: unknown): T {
  return value as T
}
