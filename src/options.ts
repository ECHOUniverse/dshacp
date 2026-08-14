/**
 * Small shared helpers for forwarding optional config fields.
 *
 * @module dshacp/options
 */

/**
 * Copy the defined fields of `source` under `keys` into a fresh object.
 * Optional plugin configs forward only the fields the caller actually set, so
 * owner schemas keep applying their own defaults and absent fields stay
 * absent on the wire.
 * @param source - the config object to copy from.
 * @param keys - the optional fields to forward when defined.
 * @returns a fresh object with only the defined fields.
 */
export function pickDefined<T extends object>(source: T, keys: readonly (keyof T)[]): Partial<T> {
  const picked: Partial<T> = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined) picked[key] = value
  }
  return picked
}
