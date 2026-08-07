/**
 * @dino/cli — brand marks shared by the Ink header (end-of-command summaries)
 * and the plain-text start-of-run banner (#2143). Single source of truth so the
 * two never drift.
 */

/** 3-line brand glyph. Rendered in DINO_THEME.brand where color is allowed. */
export const DINO_ASCII: readonly string[] = ['  ▟██▙ ▄', '  █ ●██▀', '  ▜██▛▀ '];

/** Product tagline shown beneath the wordmark. */
export const DINO_TAGLINE = 'API Intelligence Layer';

/** Brand color (green-500). Matches DINO_THEME.brand in ink/theme.ts. */
export const DINO_BRAND_HEX = '#22c55e';
