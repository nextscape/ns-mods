import type { Strength } from './levels'

// The kind of an agent()'s work sets the floor and the
// ceiling of its strength; the weight is chosen within them.
export type Kind = 'chore' | 'impl' | 'investigate' | 'verify' | 'review' | 'refute' | 'decide' | 'fix'
export const KINDS: readonly Kind[] = ['chore', 'impl', 'investigate', 'verify', 'review', 'refute', 'decide', 'fix']

export type KindRule = { floor: Strength; ceiling?: Strength }

export const KIND_RULES: Readonly<Record<Kind, KindRule>> = {
  chore: { floor: { cls: 1, effort: 'low' }, ceiling: { cls: 2, effort: 'medium' } },
  impl: { floor: { cls: 2, effort: 'medium' } },
  investigate: { floor: { cls: 2, effort: 'medium' } },
  verify: { floor: { cls: 2, effort: 'high' } },
  review: { floor: { cls: 3, effort: 'high' } },
  refute: { floor: { cls: 3, effort: 'high' } },
  decide: { floor: { cls: 3, effort: 'high' } },
  fix: { floor: { cls: 3, effort: 'high' } },
}

export function kindOf(text: string): Kind | null {
  const match = /^(chore|impl|investigate|verify|review|refute|decide|fix):/.exec(text)
  return (match?.[1] as Kind | undefined) ?? null
}

// The roles of earlier versions, and what to write instead.
export const LEGACY_KINDS: Readonly<Record<string, string>> = {
  light: 'chore:',
  work: 'impl: か investigate:',
  judge: 'verify: / review: / refute: / decide: のいずれか',
}
