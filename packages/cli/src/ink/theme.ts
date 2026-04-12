/** Dino terminal color palette. Matches brand: #22c55e (green-500). Issue #1014. */
export const DINO_THEME = {
  brand: '#22c55e',
  success: '#3dd68c',
  error: '#ff6b6b',
  warning: '#f6c90e',
  info: '#60a5fa',
  dim: '#555555',
  muted: '#888888',
  border: '#333333',
  surface: '#1f1f1f',
} as const;

export type DinoColor = keyof typeof DINO_THEME;

Object.freeze(DINO_THEME);
