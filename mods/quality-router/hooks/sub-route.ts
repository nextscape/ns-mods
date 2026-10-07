import type { Effort, Level, Top } from '../types'
import type { Kind } from './kinds'
import { TOP_SPAWN, ladder, modelClass } from './levels'
import type { Strength } from './levels'
import { compact } from './main-effort'

// What a subagent started with the Agent tool runs on,
// from two judgments made at once: the kind of its work and its weight.
// fix is never judged: a redo is found by the retry check instead.

export type SubKind = Exclude<Kind, 'fix'>
export const SUB_KINDS: readonly SubKind[] = ['chore', 'impl', 'investigate', 'verify', 'review', 'refute', 'decide']

export type Weight = 'light' | 'heavy'
export const WEIGHTS: readonly Weight[] = ['light', 'heavy']

// Custom and plugin agents keep the model their author chose.
export const ROUTABLE_TYPES: readonly string[] = ['general-purpose', 'claude']

export type SpawnFacts = {
  fork: boolean
  model?: string
  subagentType: string
  isTeammate?: true
  description: string
  prompt: string
}

export type Assignment = { tier: number; model?: string; effort?: Effort }

// An unsure kind counts as rung 2 when a retry climbs from it.
export const UNSURE_TIER = 2

export function shouldRoute(e: SpawnFacts): boolean {
  return !e.fork && e.model === undefined && e.isTeammate !== true && ROUTABLE_TYPES.includes(e.subagentType)
}

const KIND_RUBRIC = [
  '[rubric] Judge which kind of work the subagent task below is.',
  'chore = mechanical work whose result needs no judgment: listing, counting, collecting or extracting given fields, formatting, committing;',
  'impl = implementing or fixing code or documents;',
  'investigate = researching, finding a cause, or reporting findings someone will rely on;',
  'verify = checking with mechanical evidence: running tests or builds, matching facts against a source;',
  'review = judging whether a diff, design or document is good and pointing out problems;',
  'refute = trying to break a stated conclusion or finding;',
  'decide = choosing a direction or giving a pass/fail verdict.',
].join(' ')

const WEIGHT_RUBRIC = [
  '[rubric] Judge how heavy the subagent task below is.',
  'light = small and clear: one file or a few steps, an obvious answer, a low cost of a mistake;',
  'heavy = large or uncertain: many files or steps, deep reasoning, design, an unclear cause, or a high cost of a mistake.',
].join(' ')

const HEAD = 600
const TAIL = 200

type TaskFacts = Pick<SpawnFacts, 'subagentType' | 'description' | 'prompt'>

function composeTask(rubric: string, e: TaskFacts): string {
  const body = compact(e.prompt)
  const clipped = body.length <= HEAD + TAIL ? body : `${body.slice(0, HEAD)} … ${body.slice(-TAIL)}`
  return [rubric, `[type] ${e.subagentType}`, `[description] ${e.description}`, `[prompt chars=${e.prompt.length}] ${clipped}`].join('\n')
}

export function composeKind(e: TaskFacts): string {
  return composeTask(KIND_RUBRIC, e)
}

export function composeWeight(e: TaskFacts): string {
  return composeTask(WEIGHT_RUBRIC, e)
}

function pick<T extends string>(labels: readonly T[], label: string | undefined): T | undefined {
  const first = label?.split(':')[0]?.trim()
  return labels.find(one => one === first)
}

export function subKindOf(label?: string): SubKind | undefined {
  return pick(SUB_KINDS, label)
}

export function weightOf(label?: string): Weight | undefined {
  return pick(WEIGHTS, label)
}

// The assignment table. A weight that could not be judged counts as heavy, so a
// doubt never lowers the quality; a kind that could not be judged is left alone.
export function assign(kind: SubKind | undefined, weight: Weight | undefined, mainLevel: Level | null, top: Top): Assignment | null {
  if (kind === undefined) return null
  const t = TOP_SPAWN[top]
  const peak: Assignment = mainLevel === 'max' ? { tier: 4, model: t, effort: 'max' } : { tier: 3, model: t, effort: 'xhigh' }
  const heavy = weight !== 'light'
  switch (kind) {
    case 'chore':
      return { tier: 1, model: 'sonnet', effort: 'medium' }
    case 'impl':
      return heavy ? { tier: 2, effort: 'high' } : { tier: 1, model: 'sonnet', effort: 'high' }
    case 'investigate':
      return heavy ? { tier: 3, effort: 'xhigh' } : { tier: 1, model: 'sonnet', effort: 'high' }
    case 'verify':
      return heavy ? { tier: 2, model: t, effort: 'high' } : { tier: 1, model: 'sonnet', effort: 'high' }
    case 'review':
      return heavy ? peak : { tier: 2, model: t, effort: 'high' }
    case 'refute':
      return heavy ? peak : { tier: 3, model: t, effort: 'xhigh' }
    case 'decide':
      return heavy ? peak : { tier: 2, model: t, effort: 'high' }
  }
}

// An assignment as a strength; no model means the inherited top tier.
export function strengthOfAssignment(a: Assignment): Strength {
  return { cls: modelClass(a.model) ?? 3, effort: a.effort ?? 'high' }
}

export function escalate(prevTier: number, top: Top): Assignment {
  const rungs = ladder(top)
  const tier = Math.min(rungs.length - 1, prevTier + 1)
  const rung = rungs[tier]!
  return { tier, model: rung.model, effort: rung.effort }
}

export function retryKey(description: string): string {
  return description.trim()
}
