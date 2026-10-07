import { EFFORTS, isEffort, modelClass } from './levels'
import type { Dir, OverrideSignal } from './record'

// What a manual /effort or /model, and /qr up or down, say.

const compare = (a: number, b: number): Dir => (a > b ? 'up' : a < b ? 'down' : 'same')

// `from` is the level quality-router last sent: the change is read against it.
export function effortOverride(args: string, from: string | null): OverrideSignal {
  const to = args.trim().toLowerCase() || null
  const dir = to !== null && from !== null && isEffort(to) && isEffort(from) ? compare(EFFORTS.indexOf(to), EFFORTS.indexOf(from)) : 'unknown'
  return { type: 'override', what: 'effort', from, to, dir }
}

// An alias (`opus[1m]` keeps its bracket off) or a full id; `default` and
// anything else unknown is null.
export function modelClassOf(name: string | null): 1 | 2 | 3 | null {
  if (!name) return null
  const n = name.trim().toLowerCase().replace(/\[.*\]$/, '')
  if (n === 'haiku') return 1
  if (n === 'sonnet') return 2
  if (n === 'opus' || n === 'fable') return 3
  return n.startsWith('claude-') ? modelClass(n) : null
}

// `from` is the model that answered the main loop last.
export function modelOverride(args: string, from: string | null): OverrideSignal {
  const to = args.trim() || null
  const a = modelClassOf(to)
  const b = modelClassOf(from)
  return { type: 'override', what: 'model', from, to, dir: a !== null && b !== null ? compare(a, b) : 'unknown' }
}

export function parseFeedback(verb: string, arg: string): { dir: 'up' | 'down'; target: 'main' | 'sub' } | null {
  const dir = verb === 'up' || verb === '↑' ? 'up' : verb === 'down' || verb === '↓' ? 'down' : null
  if (dir === null || (arg !== '' && arg !== 'sub')) return null
  return { dir, target: arg === 'sub' ? 'sub' : 'main' }
}
