/**
 * @dino/plugins — OpenAPI discovery warning types
 *
 * Typed warnings for non-fatal issues found during discovery.
 * The CLI renders these visibly; agents can filter on warning codes.
 */

/** Warning codes for non-fatal discovery issues. */
export type DiscoveryWarningCode = 'NAME_COLLISION' | 'PARSE_PARTIAL';

/** Typed warning emitted during discovery. */
export interface DiscoveryWarning {
  /** Machine-readable code for programmatic handling. */
  code: DiscoveryWarningCode;
  /** Human-readable message for CLI/logs. */
  message: string;
  /** Structured details (e.g., colliding paths, spec version). */
  details: Record<string, unknown>;
}

/** Create a NAME_COLLISION warning. */
export function nameCollisionWarning(
  name: string,
  paths: Array<{ method: string; path: string }>,
): DiscoveryWarning {
  const pairs = paths.map((p) => `${p.method.toUpperCase()} ${p.path}`).join(' and ');
  return {
    code: 'NAME_COLLISION',
    message: `Duplicate operation name "${name}" generated for ${pairs}`,
    details: { name, paths },
  };
}

/** Create a PARSE_PARTIAL warning. */
export function parsePartialWarning(skipped: number, reason: string): DiscoveryWarning {
  return {
    code: 'PARSE_PARTIAL',
    message: `${skipped} path item(s) skipped: ${reason}`,
    details: { skipped, reason },
  };
}
