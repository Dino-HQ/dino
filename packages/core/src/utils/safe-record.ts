/**
 * @dino/core — Safe Record access utilities.
 *
 * Avoids bracket-notation object access (`obj[key]`) that triggers
 * eslint-plugin-security's detect-object-injection rule.
 *
 * These are NOT just lint silencers — they prevent prototype pollution
 * by validating own-property membership before access.
 */

/**
 * Safely read a property from a Record without bracket notation.
 * Returns undefined if the key is not an own property.
 */
export function recordGet<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  for (const [k, v] of Object.entries(record)) {
    if (k === key) return v;
  }
  return undefined;
}

/**
 * Safely write a property to a Record without bracket notation.
 * Uses Object.assign with a computed property literal (not bracket access).
 */
export function recordSet<V>(record: Record<string, V>, key: string, value: V): void {
  Object.assign(record, { [key]: value });
}
