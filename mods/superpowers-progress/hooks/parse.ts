import type { Phase, Ruling, Stage } from '../types'

// The plan's own heading names the whole, less the skill's boilerplate.
export const planTitle = (plan: string) =>
  (plan.match(/^#\s+(.+?)\s*$/m)?.[1] ?? '').replace(
    /\s*Implementation Plan$/i,
    '',
  )

export const planTasks = (plan: string) =>
  [...plan.matchAll(/^#{2,4}\s+Task\s+(\d+):\s*(.+?)\s*$/gm)].map(
    ([, n = '', subject = '']) => ({ n, subject }),
  )

export const completedTasks = (ledger: string) =>
  new Set([...ledger.matchAll(/^[-*\s]*Task (\d+): complete\b/gm)].map(m => m[1]))

// Parked first: a parked line carries a `Ruling:` of its own.
export const ledgerRulings = (ledger: string): Ruling[] =>
  ledger.split(/\r?\n/).flatMap((line): Ruling[] => {
    const text = line.replace(/^[-*\s]+/, '').trim()
    if (/\bparked\b/i.test(text)) return [{ kind: 'parked' as const, text }]
    if (/\bRuling:/.test(text)) return [{ kind: 'ruling' as const, text }]
    if (/\bdeferred\b/i.test(text)) return [{ kind: 'deferred' as const, text }]

    return []
  })

const taskOf = (text: string) => {
  const n = text.match(/\bTask (\d+)\b/)?.[1]

  return n === undefined ? undefined : Number(n)
}
const roundOf = (text: string) =>
  Number(text.match(/fix (?:round|wave) (\d+)/i)?.[1] ?? 0)

// What an Agent dispatch is, from the descriptions and opening lines SDD's
// prompt templates give each role; undefined for any other subagent.
export const agentStage = (
  description: string,
  prompt: string,
  before: Stage | null,
): Stage | undefined => {
  // The opening line only: a brief's body may name other tasks.
  const head = `${description}\n${prompt.split('\n', 1)[0] ?? ''}`
  const isRereview = /re-?review/i.test(head)
  const task = taskOf(head)

  if (task === undefined) {
    const isFinal = /\bfinal\b|whole-branch|Senior Code Reviewer/i.test(head)
    if (!isFinal) return undefined
    const isFix = !isRereview && /\bfix/i.test(head)

    return { task: null, step: isFix ? 'final-fix' : 'final-review', round: 0 }
  }
  const round = before?.task === task ? before.round : 0

  if (isRereview) {
    return { task, step: 'rereview', round: roundOf(head) || round }
  }
  if (/You are implementing Task|^Implement Task/i.test(head)) {
    // A fresh implementer after round 3 is still a fix round.
    const isRedo = before?.task === task && before.step !== 'implement'

    return isRedo
      ? { task, step: 'fix', round: round + 1 }
      : { task, step: 'implement', round: 0 }
  }
  if (/You are reviewing one task|^Review Task/i.test(head)) {
    return { task, step: 'review', round }
  }

  return undefined
}

// A fix round sent back to the implementer that is still running.
export const messageStage = (
  message: string,
  before: Stage | null,
): Stage | undefined => {
  const round = roundOf(message)
  if (!before || round === 0) return undefined

  return before.task === null
    ? { task: null, step: 'final-fix', round }
    : { task: before.task, step: 'fix', round }
}

const PHASES: Record<string, Phase> = {
  brainstorming: 'design',
  'writing-plans': 'plan',
  'subagent-driven-development': 'build',
  'executing-plans': 'build',
  'finishing-a-development-branch': 'finish',
}

export const skillPhase = (skill: string): Phase | undefined => {
  const [owner, name] = skill.includes(':') ? skill.split(':') : ['', skill]

  return owner === 'superpowers' && name ? PHASES[name] : undefined
}
