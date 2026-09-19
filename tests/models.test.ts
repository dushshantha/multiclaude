import { describe, it, expect } from 'vitest'
import { VALID_MODEL_VALUES, MODEL_IDS, DEFAULT_MODEL, normalizeModel } from '../src/models.js'

describe('models registry', () => {
  it('VALID_MODEL_VALUES includes all four tiers', () => {
    expect(VALID_MODEL_VALUES).toContain('haiku')
    expect(VALID_MODEL_VALUES).toContain('sonnet')
    expect(VALID_MODEL_VALUES).toContain('opus')
    expect(VALID_MODEL_VALUES).toContain('fable')
  })

  it('MODEL_IDS maps to correct model ID strings', () => {
    expect(MODEL_IDS.haiku).toBe('claude-haiku-4-5-20251001')
    expect(MODEL_IDS.sonnet).toBe('claude-sonnet-5')
    expect(MODEL_IDS.opus).toBe('claude-opus-5')
    expect(MODEL_IDS.fable).toBe('claude-fable-5-1')
  })

  it('DEFAULT_MODEL is sonnet', () => {
    expect(DEFAULT_MODEL).toBe('sonnet')
  })

  describe('normalizeModel', () => {
    it('returns valid tier for each known value', () => {
      expect(normalizeModel('haiku')).toBe('haiku')
      expect(normalizeModel('sonnet')).toBe('sonnet')
      expect(normalizeModel('opus')).toBe('opus')
      expect(normalizeModel('fable')).toBe('fable')
    })

    it('returns null for unknown tier', () => {
      expect(normalizeModel('gpt-4')).toBeNull()
      expect(normalizeModel('unknown')).toBeNull()
      expect(normalizeModel('')).toBeNull()
      expect(normalizeModel('SONNET')).toBeNull()
    })
  })
})
