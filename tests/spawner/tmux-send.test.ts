import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
}))

vi.mock('child_process', () => ({
  execSync: mockExecSync,
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  openSync: vi.fn(() => 1),
}))

import {
  stripAnsiDim,
  stripBoxDrawing,
  cleanComposerLine,
  capturePaneText,
  sendToPane,
} from '../../src/spawner/tmux.js'

describe('stripAnsiDim', () => {
  it('removes SGR 2 (dim/faint) text and its reset', () => {
    // \x1b[2m marks dim start, \x1b[22m resets intensity
    const input = 'visible \x1b[2mghost text\x1b[22m more visible'
    expect(stripAnsiDim(input)).toBe('visible  more visible')
  })

  it('handles dim text at end of line (no closing reset)', () => {
    const input = 'prompt> \x1b[2msuggestion here'
    expect(stripAnsiDim(input)).toBe('prompt> ')
  })

  it('handles nested SGR sequences inside dim region', () => {
    const input = 'ok \x1b[2m\x1b[37mghost\x1b[0m rest'
    // SGR 0 (full reset) also ends dim
    expect(stripAnsiDim(input)).toBe('ok  rest')
  })

  it('returns unmodified string when no dim sequences present', () => {
    const input = 'no dim here'
    expect(stripAnsiDim(input)).toBe('no dim here')
  })

  it('handles multiple dim regions', () => {
    const input = 'a \x1b[2mb\x1b[22m c \x1b[2md\x1b[22m e'
    expect(stripAnsiDim(input)).toBe('a  c  e')
  })

  it('handles SGR 2 combined with other attributes', () => {
    // \x1b[1;2m sets bold+dim
    const input = 'before \x1b[1;2mfaint bold\x1b[22m after'
    expect(stripAnsiDim(input)).toBe('before  after')
  })
})

describe('stripBoxDrawing', () => {
  it('removes Unicode box-drawing characters │ ┃', () => {
    expect(stripBoxDrawing('│ hello ┃')).toBe(' hello ')
  })

  it('removes ASCII pipe used as border', () => {
    expect(stripBoxDrawing('| text |')).toBe(' text ')
  })

  it('returns unmodified string when no borders present', () => {
    expect(stripBoxDrawing('just text')).toBe('just text')
  })

  it('handles lines with only box drawing', () => {
    expect(stripBoxDrawing('│││')).toBe('')
  })
})

describe('cleanComposerLine', () => {
  it('strips dim ghost text and box borders together', () => {
    const input = '│ prompt> \x1b[2msuggestion\x1b[22m │'
    const result = cleanComposerLine(input)
    expect(result).toBe('prompt>')
  })

  it('strips all remaining ANSI sequences after dim removal', () => {
    const input = '\x1b[1;32mprompt>\x1b[0m hello'
    const result = cleanComposerLine(input)
    expect(result).toBe('prompt> hello')
  })

  it('trims whitespace', () => {
    const input = '   some text   '
    expect(cleanComposerLine(input)).toBe('some text')
  })

  it('returns empty string for border-only line', () => {
    const input = '│ \x1b[2m \x1b[22m │'
    expect(cleanComposerLine(input)).toBe('')
  })
})

describe('capturePaneText', () => {
  beforeEach(() => {
    mockExecSync.mockReset()
  })

  it('calls tmux capture-pane with -e flag for ANSI escapes and -p to print', () => {
    mockExecSync.mockReturnValueOnce('line1\nline2\n')
    capturePaneText('sess:win')
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('capture-pane')
    expect(call).toContain('-e')
    expect(call).toContain('-p')
    expect(call).toContain('-t')
  })

  it('returns trimmed captured text', () => {
    mockExecSync.mockReturnValueOnce('  content here  \n\n')
    const result = capturePaneText('sess:win')
    expect(result).toBe('content here')
  })

  it('returns empty string on failure', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('pane gone') })
    const result = capturePaneText('sess:win')
    expect(result).toBe('')
  })
})

describe('sendToPane', () => {
  beforeEach(() => {
    mockExecSync.mockReset()
  })

  it('sends text via send-keys then verifies with capture-pane', () => {
    // First call: send-keys for the text
    mockExecSync.mockReturnValueOnce(undefined)
    // Second call: send-keys Enter
    mockExecSync.mockReturnValueOnce(undefined)
    // Third call: capture-pane to verify submit (empty = submitted)
    mockExecSync.mockReturnValueOnce('\n\n')

    const result = sendToPane('sess:win', 'hello world', { retryDelayMs: 0 })
    expect(result.sent).toBe(true)
    // send-keys for text, send-keys Enter, capture-pane verify
    expect(mockExecSync).toHaveBeenCalledTimes(3)
  })

  it('retries Enter when capture-pane shows text still in composer', () => {
    // send-keys text
    mockExecSync.mockReturnValueOnce(undefined)
    // send-keys Enter (attempt 0)
    mockExecSync.mockReturnValueOnce(undefined)
    // capture-pane: text still there (not submitted)
    mockExecSync.mockReturnValueOnce('hello world\n')
    // send-keys Enter (attempt 1 = retry)
    mockExecSync.mockReturnValueOnce(undefined)
    // capture-pane: now clear
    mockExecSync.mockReturnValueOnce('\n\n')

    const result = sendToPane('sess:win', 'hello world', { retryDelayMs: 0 })
    expect(result.sent).toBe(true)
    expect(result.enterRetries).toBe(1)
  })

  it('does not retype text on retry, only resends Enter', () => {
    // send-keys text
    mockExecSync.mockReturnValueOnce(undefined)
    // send-keys Enter (attempt 0)
    mockExecSync.mockReturnValueOnce(undefined)
    // capture-pane: still there
    mockExecSync.mockReturnValueOnce('hello world\n')
    // send-keys Enter (attempt 1 = retry)
    mockExecSync.mockReturnValueOnce(undefined)
    // capture-pane: clear
    mockExecSync.mockReturnValueOnce('\n\n')

    sendToPane('sess:win', 'hello world', { retryDelayMs: 0 })

    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    // Only the first call should contain the actual text
    const textSends = calls.filter(c => c.includes('send-keys') && c.includes('hello world'))
    expect(textSends).toHaveLength(1)
    // The retry should be Enter-only
    const enterOnlySends = calls.filter(c => c.includes('send-keys') && !c.includes('hello world') && c.includes('Enter'))
    expect(enterOnlySends.length).toBeGreaterThanOrEqual(1)
  })

  it('gives up after max retries and returns sent=false', () => {
    // send-keys text
    mockExecSync.mockReturnValueOnce(undefined)

    // For each attempt (1 initial + 3 retries = 4 total):
    // send-keys Enter, then capture-pane showing text still there
    for (let i = 0; i < 4; i++) {
      mockExecSync.mockReturnValueOnce(undefined) // Enter
      mockExecSync.mockReturnValueOnce('hello world\n') // capture-pane
    }

    const result = sendToPane('sess:win', 'hello world', { maxEnterRetries: 3, retryDelayMs: 0 })
    expect(result.sent).toBe(false)
    expect(result.enterRetries).toBe(3)
  })

  it('handles bordered composer with dim ghost text correctly', () => {
    // send-keys text
    mockExecSync.mockReturnValueOnce(undefined)
    // send-keys Enter
    mockExecSync.mockReturnValueOnce(undefined)
    // capture-pane: border-only with dim ghost = effectively empty = submitted
    mockExecSync.mockReturnValueOnce('│ \x1b[2mType a message\x1b[22m │\n')

    const result = sendToPane('sess:win', 'test message', { retryDelayMs: 0 })
    expect(result.sent).toBe(true)
  })
})
