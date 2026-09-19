export const VALID_MODEL_VALUES = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type ModelValue = typeof VALID_MODEL_VALUES[number]

export const MODEL_IDS: Record<ModelValue, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  fable: 'claude-fable-5-1',
}

export const DEFAULT_MODEL: ModelValue = 'sonnet'

/**
 * Normalise a model string to a canonical ModelValue.
 * Returns the canonical value, or null when the input is invalid.
 */
export function normalizeModel(model: string): ModelValue | null {
  if ((VALID_MODEL_VALUES as readonly string[]).includes(model)) return model as ModelValue
  return null
}
