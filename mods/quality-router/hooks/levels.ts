import type { Effort, Level, Top } from '../types'

// The four levels the main loop runs at, lowest first.
export const LEVELS: readonly Level[] = ['medium', 'high', 'xhigh', 'max']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// turn.step needs full ids. agent.spawn and Workflow agent() take aliases,
// except Fable, whose alias is unverified.
export const TOP_IDS: Readonly<Record<Top, string>> = {
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}
export const TOP_SPAWN: Readonly<Record<Top, string>> = {
  opus: 'opus',
  fable: 'claude-fable-5-1',
}

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

export function isTop(value: unknown): value is Top {
  return value === 'opus' || value === 'fable'
}

export function rank(level: Level): number {
  return LEVELS.indexOf(level)
}

// The session's effort as a step names it, read as one of our levels.
export function asLevel(effort: string | number | undefined): Level | null {
  if (effort === 'low') return 'medium'
  return isLevel(effort) ? effort : null
}

export function maxLevel(...levels: Array<Level | null | undefined>): Level | null {
  let best: Level | null = null
  for (const level of levels) {
    if (level && (best === null || rank(level) > rank(best))) best = level
  }
  return best
}

export function minLevel(a: Level, b: Level): Level {
  return rank(a) <= rank(b) ? a : b
}

export function up(level: Level, steps = 1): Level {
  return LEVELS[Math.min(LEVELS.length - 1, rank(level) + steps)] ?? 'max'
}

export function down(level: Level): Level {
  return LEVELS[Math.max(0, rank(level) - 1)] ?? 'medium'
}

export type Bounds = { floor: Level; ceiling: Level; skillFloor: Level | null }

// level = min(ceiling, max(floor, skillFloor, base)).
export function applyBounds(base: Level, bounds: Bounds): Level {
  return minLevel(bounds.ceiling, maxLevel(bounds.floor, bounds.skillFloor, base) ?? base)
}

// Which bound set the level applyBounds returns (the log records
// it): the ceiling when it cut, else the floor that lifted the base, the skill
// floor when both lift it as far. null: the base went out as it was.
export type Bound = 'floor' | 'skill' | 'ceiling'

export function boundOf(base: Level, bounds: Bounds): Bound | null {
  const level = applyBounds(base, bounds)
  const wanted = maxLevel(bounds.floor, bounds.skillFloor, base) ?? base
  if (rank(level) < rank(wanted)) return 'ceiling'
  if (level === base) return null
  return bounds.skillFloor === level ? 'skill' : 'floor'
}

export function isTopFamily(model: string): boolean {
  return /^claude-(opus|fable|mythos)-/.test(model) || model === 'opus' || model === 'fable'
}

export type Rung = { model: string; effort: Effort }

// The ladder: model first, then effort; the last rung is the top model.
export function ladder(top: Top): readonly Rung[] {
  return [
    { model: 'haiku', effort: 'low' },
    { model: 'sonnet', effort: 'medium' },
    { model: 'opus', effort: 'high' },
    { model: 'opus', effort: 'xhigh' },
    { model: TOP_SPAWN[top], effort: 'max' },
  ]
}

// Strength: the model tier first (haiku < sonnet < top), then effort.
// An omitted model inherits the main model, which the guard keeps top.
export type ModelClass = 1 | 2 | 3
export type Strength = { cls: ModelClass; effort: Effort }

export function modelClass(model: string | undefined): ModelClass | null {
  if (model === undefined) return 3
  if (model === 'haiku' || /^claude-haiku-/.test(model)) return 1
  if (model === 'sonnet' || /^claude-sonnet-/.test(model)) return 2
  if (isTopFamily(model)) return 3
  return null
}

export function compareStrength(a: Strength, b: Strength): number {
  if (a.cls !== b.cls) return a.cls - b.cls
  return EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort)
}

// The ladder's rungs as strengths; the top rung is the top model whatever it is.
export const RUNG_STRENGTH: readonly Strength[] = [
  { cls: 1, effort: 'low' },
  { cls: 2, effort: 'medium' },
  { cls: 3, effort: 'high' },
  { cls: 3, effort: 'xhigh' },
  { cls: 3, effort: 'max' },
]

const CLASS_NAMES: Readonly<Record<ModelClass, string>> = { 1: 'haiku', 2: 'sonnet', 3: '上位' }

export function formatStrength(s: Strength): string {
  return `${CLASS_NAMES[s.cls]}・${s.effort}`
}
