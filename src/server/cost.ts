export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
}

export const DEFAULT_PRICES: Record<string, ModelPricing> = {
  sonnet: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  haiku: { inputPerMillion: 0.80, outputPerMillion: 4.0 },
  opus: { inputPerMillion: 15.0, outputPerMillion: 75.0 },
}

/**
 * Calculate cost in USD for a given token usage and model.
 * Model matching is case-insensitive substring: "claude-sonnet-4-6" → "sonnet".
 * Falls back to "sonnet" pricing if the model string doesn't match any known tier.
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  prices: Record<string, ModelPricing> = DEFAULT_PRICES
): number {
  const modelLower = model.toLowerCase()
  const key = Object.keys(prices).find(k => modelLower.includes(k)) ?? 'sonnet'
  const pricing = prices[key] ?? prices['sonnet']
  return (inputTokens / 1_000_000) * pricing.inputPerMillion
    + (outputTokens / 1_000_000) * pricing.outputPerMillion
}
