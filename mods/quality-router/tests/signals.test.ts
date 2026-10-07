import { describe, expect, test } from 'claude-code/testing'
import { effortOverride, modelClassOf, modelOverride, parseFeedback } from '../hooks/signals'

describe('signals', () => {
  test('a manual /effort reads up, down or same against the level last sent', () => {
    expect(effortOverride('max', 'xhigh')).toEqual({ type: 'override', what: 'effort', from: 'xhigh', to: 'max', dir: 'up' })
    expect(effortOverride(' High ', 'xhigh').dir).toBe('down')
    expect(effortOverride('xhigh', 'xhigh').dir).toBe('same')
    expect(effortOverride('low', 'medium').dir).toBe('down')
  })

  test('an /effort with no argument, an unknown value or nothing sent yet is unknown', () => {
    expect(effortOverride('', 'high')).toEqual({ type: 'override', what: 'effort', from: 'high', to: null, dir: 'unknown' })
    expect(effortOverride('auto', 'high').dir).toBe('unknown')
    expect(effortOverride('max', null).dir).toBe('unknown')
  })

  test('model names and ids read as haiku 1, sonnet 2, the top models 3', () => {
    expect(modelClassOf('haiku')).toBe(1)
    expect(modelClassOf('Sonnet')).toBe(2)
    expect(modelClassOf('opus[1m]')).toBe(3)
    expect(modelClassOf('fable')).toBe(3)
    expect(modelClassOf('claude-sonnet-5-5')).toBe(2)
    expect(modelClassOf('claude-fable-5-1')).toBe(3)
    expect(modelClassOf('default')).toBeNull()
    expect(modelClassOf(null)).toBeNull()
  })

  test('a manual /model reads against the model that answered last', () => {
    expect(modelOverride('sonnet', 'claude-opus-5-5')).toEqual({ type: 'override', what: 'model', from: 'claude-opus-5-5', to: 'sonnet', dir: 'down' })
    expect(modelOverride('fable', 'claude-opus-5-5').dir).toBe('same')
    expect(modelOverride('opus', 'claude-sonnet-5-5').dir).toBe('up')
    expect(modelOverride('', 'claude-opus-5-5').dir).toBe('unknown')
  })

  test('/qr up and down, with arrows, for the main turn or a child', () => {
    expect(parseFeedback('up', '')).toEqual({ dir: 'up', target: 'main' })
    expect(parseFeedback('↓', 'sub')).toEqual({ dir: 'down', target: 'sub' })
    expect(parseFeedback('up', 'main')).toBeNull()
    expect(parseFeedback('stats', '')).toBeNull()
  })
})
