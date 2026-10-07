import type { Effort } from '../types'
import type { AgentCall, Token } from './gate-lexer'
import { KIND_RULES, LEGACY_KINDS, kindOf } from './kinds'
import { EFFORTS, RUNG_STRENGTH, compareStrength, formatStrength, isEffort, modelClass } from './levels'
import type { ModelClass, Strength } from './levels'

// The Workflow gate's rules R0-R5 and the Japanese
// text that sends a script back.

export type Value = { kind: 'literal'; value: string } | { kind: 'template'; head: string } | { kind: 'expr' }
export type Violation = {
  ordinal: number
  label: string | null
  rule: 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5'
  message: string
}

const OPTIONS_INLINE = 'agent() の第2引数はオブジェクトリテラルで直接書いてください（変数や関数の戻り値では静的に確かめられないため）'
const LABEL_LITERAL = 'label は文字列かテンプレート文字列で直接書き、頭に種類（chore: など）を付けてください（静的に確かめるため）'
const KIND_PREFIX = 'ラベルの頭に種類（chore: / impl: / investigate: / verify: / review: / refute: / decide: / fix:）のいずれかを付けてください'
const MODEL_LITERAL = 'model は文字列で直接書いてください（静的に確かめるため）'
const EFFORT_LITERAL = 'effort は文字列で直接書いてください（静的に確かめるため）'
const EFFORT_MISSING = 'effort を文字列で書くか、...LADDER[n]（n は数字）を使ってください（重さを静的に確かめるため）'
const INDEX_LITERAL = 'LADDER の添字は数字で書いてください（添字に式を使えるのは fix: だけです）'
const INDEX_RANGE = `LADDER の添字は 0〜${RUNG_STRENGTH.length - 1} で書いてください`
const FIX_UP = 'fix は段を1つ以上上げてください（...LADDER[tier + 1] の展開か、上位モデル（opus か claude-fable-5-1）で effort high 以上）'
const INHERITS = '。model を省くと本体のモデルを引き継ぎます'

const LADDER_SPREAD = /^LADDER\s*\[/
// A rung whose index is a literal number, so its strength can be read.
const NUMERIC_RUNG = /^LADDER\s*\[\s*(\d+)\s*\]$/

// Only fix may index the ladder with an expression.
function spreadOnlyLadder(kind: string): string {
  return `展開（...）は ...LADDER[n]${kind === 'fix' ? ' ' : '（n は数字）'}だけにしてください（静的に確かめるため）`
}

// A string or template literal, or one followed by `+` ('impl:' + name), whose
// literal head is what the rules read; anything else is an expression.
export function valueOf(tokens: Token[] | undefined): Value | undefined {
  if (!tokens || tokens.length === 0) return undefined
  const first = tokens[0]!
  const joined = tokens.length > 1 && tokens[1]?.kind === 'punct' && tokens[1].text === '+'
  if (tokens.length > 1 && !joined) return { kind: 'expr' }
  let value: Value
  if (first.kind === 'string') value = { kind: 'literal', value: first.text.slice(1, -1) }
  else if (first.kind === 'template') {
    const body = first.text.slice(1, -1)
    const at = body.indexOf('${')
    value = at < 0 ? { kind: 'literal', value: body } : { kind: 'template', head: body.slice(0, at) }
  } else return { kind: 'expr' }
  if (!joined) return value
  return { kind: 'template', head: value.kind === 'literal' ? value.value : value.head }
}

function headOf(value: Value | undefined): string {
  return value?.kind === 'literal' ? value.value : value?.kind === 'template' ? value.head : ''
}

function isModelName(value: string): boolean {
  return ['haiku', 'sonnet', 'opus'].includes(value) || /^claude-[a-z0-9-]+$/.test(value)
}

// Explicit keys and a rung spread may both be written, and the lexer keeps no
// order, so each key may come from either of them (in JavaScript the one
// written last wins, key by key). The floor reads the weakest pairing, the
// lower tier with the lower effort; the ceiling the strongest. An omitted
// model inherits the session model, which counts as the top tier.
// undefined: no effort was written and no rung gives one.
function bounds(
  cls: ModelClass | undefined,
  effort: Effort | undefined,
  rung: Strength | undefined,
): { weaker: Strength; stronger: Strength } | undefined {
  const classes = [cls, rung?.cls].filter((c): c is ModelClass => c !== undefined)
  const efforts = [effort, rung?.effort].filter((e): e is Effort => e !== undefined)
  if (efforts.length === 0) return undefined
  if (classes.length === 0) classes.push(3)
  efforts.sort((x, y) => EFFORTS.indexOf(x) - EFFORTS.indexOf(y))
  return {
    weaker: { cls: Math.min(...classes) as ModelClass, effort: efforts[0]! },
    stronger: { cls: Math.max(...classes) as ModelClass, effort: efforts[efforts.length - 1]! },
  }
}

export function checkCalls(calls: AgentCall[]): Violation[] {
  const out: Violation[] = []
  for (const call of calls) {
    const o = call.options
    if (o.kind === 'dynamic') {
      // Options in a variable or built by a call cannot be read statically,
      // and reading past them would let a script step around the rules.
      out.push({ ordinal: call.ordinal, label: null, rule: 'R0', message: OPTIONS_INLINE })
      continue
    }
    const entries = o.kind === 'object' ? o.entries : {}
    const spreads = o.kind === 'object' ? o.spreads : []
    const label = valueOf(entries.label)
    const labelText = label?.kind === 'literal' ? label.value : label?.kind === 'template' ? `${label.head}…` : null
    const add = (rule: Violation['rule'], message: string) =>
      out.push({ ordinal: call.ordinal, label: labelText, rule, message })

    // R4 applies to every call, whatever its kind.
    const model = valueOf(entries.model)
    const effort = valueOf(entries.effort)
    const badModel = model?.kind === 'literal' && !isModelName(model.value)
    // A claude- id outside the known families has no tier, so neither its
    // floor nor its ceiling could be checked.
    const unknownTier = model?.kind === 'literal' && !badModel && modelClass(model.value) === null
    const badEffort = effort?.kind === 'literal' && !isEffort(effort.value)
    if (model?.kind === 'literal' && badModel) {
      add('R4', `model「${model.value}」は使えません。haiku / sonnet / opus か、claude- で始まる正式IDにしてください`)
    }
    if (model?.kind === 'literal' && unknownTier) {
      add(
        'R4',
        `model「${model.value}」は格（haiku / sonnet / 上位）が分かりません。haiku / sonnet / opus か、claude-haiku- / claude-sonnet- / claude-opus- / claude-fable- / claude-mythos- で始まる正式IDにしてください`,
      )
    }
    if (effort?.kind === 'literal' && badEffort) {
      add('R4', `effort「${effort.value}」は使えません。low / medium / high / xhigh / max のいずれかにしてください`)
    }

    // R0: the label starts with one of the eight kinds.
    const head = headOf(label)
    const kind = kindOf(head)
    if (kind === null) {
      const legacy = /^(light|work|judge):/.exec(head)?.[1]
      if (legacy !== undefined) add('R0', `${legacy}: は旧ラベルです。${LEGACY_KINDS[legacy]} に置き換えてください`)
      else add('R0', label?.kind === 'expr' ? LABEL_LITERAL : KIND_PREFIX)
      continue
    }
    // A value R4 rejected leaves no strength to read.
    if (badModel || unknownTier || badEffort) continue

    // R1: any spread but a ladder rung could set model or effort to anything
    // at run time, so the strength could not be read. This holds for
    // fix too: a rung with an expression index is the only spread it may use.
    if (spreads.some(spread => !LADDER_SPREAD.test(spread))) {
      add('R1', spreadOnlyLadder(kind))
      continue
    }
    const rungIndexes = spreads.flatMap(spread => {
      const match = NUMERIC_RUNG.exec(spread)
      return match ? [Number(match[1])] : []
    })
    if (rungIndexes.some(index => index >= RUNG_STRENGTH.length)) {
      add('R1', INDEX_RANGE)
      continue
    }
    // R5: fix only has to use the ladder; its index may be an expression,
    // since "one rung above the last" cannot be read statically.
    if (kind === 'fix' && spreads.length > 0) continue

    // Every rung sets both model and effort, so the last one written wins.
    const rungIndex = rungIndexes.at(-1)
    const rung = rungIndex !== undefined ? RUNG_STRENGTH[rungIndex] : undefined
    const explicitCls = model?.kind === 'literal' ? (modelClass(model.value) ?? undefined) : undefined
    const explicitEffort = effort?.kind === 'literal' && isEffort(effort.value) ? effort.value : undefined
    const unreadableModel = model !== undefined && model.kind !== 'literal'

    if (kind === 'fix') {
      const read = bounds(explicitCls, explicitEffort, rung)
      if (unreadableModel || read === undefined || compareStrength(read.weaker, KIND_RULES.fix.floor) < 0) add('R5', FIX_UP)
      continue
    }

    // R1: the weight must be readable.
    if (unreadableModel) {
      add('R1', MODEL_LITERAL)
      continue
    }
    // An effort written as an expression could override a rung at run time.
    if (effort !== undefined && effort.kind !== 'literal') {
      add('R1', EFFORT_LITERAL)
      continue
    }
    // An expression index could override the explicit keys at run time.
    if (spreads.some(spread => !NUMERIC_RUNG.test(spread))) {
      add('R1', INDEX_LITERAL)
      continue
    }
    const read = bounds(explicitCls, explicitEffort, rung)
    if (read === undefined) {
      add('R1', EFFORT_MISSING)
      continue
    }

    // R2 reads the weakest pairing against the floor, R3 the strongest
    // against the ceiling (only chore has one).
    const { weaker, stronger } = read
    const { floor, ceiling } = KIND_RULES[kind]
    if (compareStrength(weaker, floor) < 0) {
      add('R2', `${kind} の下限は ${formatStrength(floor)} です（現在 ${formatStrength(weaker)}）`)
    }
    if (ceiling !== undefined && compareStrength(stronger, ceiling) > 0) {
      const inherits = model === undefined && rung === undefined ? INHERITS : ''
      add('R3', `${kind} の上限は ${formatStrength(ceiling)} です（現在 ${formatStrength(stronger)}${inherits}）`)
    }
  }
  return out
}

export function formatDeny(violations: Violation[]): string {
  return [
    `quality-router: Workflow を差し戻しました（${violations.length}件）。`,
    ...violations.map(v => `- ${v.ordinal}番目の agent（${v.label ?? 'ラベルなし'}）: ${v.message}`),
    '直したら Workflow をもう一度呼んでください。種類と段（LADDER）の定義はシステムプロンプトの quality-router 節にあります。',
  ].join('\n')
}

// Session-written scripts live in ~/.claude/projects/<project>/<session>/workflows/scripts/.
export function isSessionScriptPath(path: string, sessionId: string): boolean {
  return path.replace(/\\/g, '/').includes(`/${sessionId}/workflows/scripts/`)
}
