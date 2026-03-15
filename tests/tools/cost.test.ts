import { describe, it, expect } from 'vitest'
import { calculateCost, DEFAULT_PRICES } from '../../src/server/cost.js'

describe('calculateCost', () => {
  it('calculates sonnet cost correctly', () => {
    // 1M input tokens + 1M output tokens
    const cost = calculateCost(1_000_000, 1_000_000, 'sonnet')
    expect(cost).toBeCloseTo(18.0) // $3 + $15
  })

  it('calculates haiku cost correctly', () => {
    const cost = calculateCost(1_000_000, 1_000_000, 'haiku')
    expect(cost).toBeCloseTo(4.8) // $0.80 + $4
  })

  it('calculates opus cost correctly', () => {
    const cost = calculateCost(1_000_000, 1_000_000, 'opus')
    expect(cost).toBeCloseTo(90.0) // $15 + $75
  })

  it('matches on model substring (claude-sonnet-4-6)', () => {
    const cost = calculateCost(1_000_000, 0, 'claude-sonnet-4-6')
    expect(cost).toBeCloseTo(3.0)
  })

  it('falls back to sonnet pricing for unknown model', () => {
    const cost = calculateCost(1_000_000, 0, 'unknown-model')
    expect(cost).toBeCloseTo(3.0)
  })

  it('scales linearly with token count', () => {
    const cost = calculateCost(500, 250, 'sonnet')
    expect(cost).toBeCloseTo((500 / 1_000_000) * 3 + (250 / 1_000_000) * 15)
  })

  it('accepts custom prices', () => {
    const prices = { custom: { inputPerMillion: 1.0, outputPerMillion: 2.0 } }
    const cost = calculateCost(1_000_000, 1_000_000, 'custom', prices)
    expect(cost).toBeCloseTo(3.0)
  })
})
