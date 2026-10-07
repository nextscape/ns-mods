import { describe, expect, test } from 'claude-code/testing'

import { scanAgentCalls } from '../hooks/gate-lexer'
import { checkCalls, formatDeny, isSessionScriptPath } from '../hooks/gate-rules'
import { guidanceText } from '../hooks/guidance'

const rules = (src: string) => checkCalls(scanAgentCalls(src)).map(v => v.rule)
const messages = (src: string) => checkCalls(scanAgentCalls(src)).map(v => `${v.rule} ${v.message}`)

describe('gate-rules', () => {
  test('R0: a kind prefix is required, and old labels are sent back with their replacement', () => {
    expect(rules("agent('p', { effort: 'high' })")).toEqual(['R0'])
    expect(messages("agent('p', { label: 'light:scan', effort: 'low' })")).toEqual(['R0 light: は旧ラベルです。chore: に置き換えてください'])
    expect(messages("agent('p', { label: 'work:impl', effort: 'high' })")).toEqual(['R0 work: は旧ラベルです。impl: か investigate: に置き換えてください'])
    expect(messages("agent('p', { label: 'judge:x', effort: 'high' })")).toEqual(['R0 judge: は旧ラベルです。verify: / review: / refute: / decide: のいずれか に置き換えてください'])
  })

  test('R0: every agent needs a kind prefix on its label', () => {
    expect(rules("agent('p')")).toEqual(['R0'])
    expect(rules("agent('p', { label: 'scan', effort: 'low' })")).toEqual(['R0'])
    expect(messages("agent('p', { label: 'scan', effort: 'low' })")).toEqual([
      'R0 ラベルの頭に種類（chore: / impl: / investigate: / verify: / review: / refute: / decide: / fix:）のいずれかを付けてください',
    ])
  })

  test('R0: options and labels the gate cannot read are sent back with how to write them', () => {
    // Options in a variable, even with a prefixed label inside, cannot be checked.
    expect(messages("const o = { label: 'impl:x', effort: 'high' }; agent('p', o)")).toEqual([
      'R0 agent() の第2引数はオブジェクトリテラルで直接書いてください（変数や関数の戻り値では静的に確かめられないため）',
    ])
    const labelInVariable = 'R0 label は文字列かテンプレート文字列で直接書き、頭に種類（chore: など）を付けてください（静的に確かめるため）'
    expect(messages("agent('p', { label: name, effort: 'high' })")).toEqual([labelInVariable])
    expect(messages("agent('p', { label, effort: 'high' })")).toEqual([labelInVariable])
    // A literal prefix joined to the rest is read like a template's head.
    expect(rules("agent('p', { label: 'impl:' + name, effort: 'high' })")).toEqual([])
    expect(rules("agent('p', { label: 'step-' + name, effort: 'high' })")).toEqual(['R0'])
    expect(rules("agent(p, { label: `${kind}:x`, effort: 'high' })")).toEqual(['R0'])
  })

  test('R4 is reported whatever the kind, also next to R0, and skips the strength check', () => {
    expect(rules("agent('p', { label: 'scan', effort: 'extreme' })")).toEqual(['R4', 'R0'])
    expect(rules("agent('p', { label: 'review:x', model: 'gpt-5', effort: 'high' })")).toEqual(['R4'])
    expect(rules("agent('p', { label: 'chore:x', effort: 'extreme' })")).toEqual(['R4'])
  })

  test('R1: the weight must be readable', () => {
    expect(rules("agent('p', { label: 'impl:x' })")).toEqual(['R1'])
    expect(rules("agent('p', { label: 'impl:x', ...LADDER[tier] })")).toEqual(['R1'])
    expect(rules("agent('p', { label: 'impl:x', model: m, effort: 'high' })")).toEqual(['R1'])
    expect(rules("agent('p', { label: 'impl:x', ...LADDER[2] })")).toEqual([])
    expect(rules("agent('p', { label: 'impl:x', effort: 'high' })")).toEqual([])
    expect(messages("agent('p', { label: 'impl:x' })")).toEqual([
      'R1 effort を文字列で書くか、...LADDER[n]（n は数字）を使ってください（重さを静的に確かめるため）',
    ])
    expect(messages("agent('p', { label: 'impl:x', ...LADDER[tier] })")).toEqual([
      'R1 LADDER の添字は数字で書いてください（添字に式を使えるのは fix: だけです）',
    ])
    expect(messages("agent('p', { label: 'impl:x', model: m, effort: 'high' })")).toEqual([
      'R1 model は文字列で直接書いてください（静的に確かめるため）',
    ])
    // An expression index next to explicit keys could still override them at run time.
    expect(rules("agent('p', { label: 'chore:x', model: 'haiku', effort: 'low', ...LADDER[tier] })")).toEqual(['R1'])
    expect(rules("agent('p', { label: 'impl:x', effort: big ? 'max' : 'high' })")).toEqual(['R1'])
    // An effort written as an expression could override a numeric rung at run time.
    expect(messages("agent('p', { label: 'review:x', effort: big ? 'low' : 'high', ...LADDER[2] })")).toEqual([
      'R1 effort は文字列で直接書いてください（静的に確かめるため）',
    ])
    expect(rules("agent('p', { label: 'chore:x', model: 'haiku', effort: `${e}`, ...LADDER[0] })")).toEqual(['R1'])
    // A numeric index past the top rung gives no strength to read.
    expect(messages("agent('p', { label: 'impl:x', ...LADDER[5] })")).toEqual(['R1 LADDER の添字は 0〜4 で書いてください'])
    expect(messages("agent('p', { label: 'impl:x', ...LADDER[10] })")).toEqual(['R1 LADDER の添字は 0〜4 で書いてください'])
    expect(rules("agent('p', { label: 'fix:1', ...LADDER[7] })")).toEqual(['R1'])
    expect(rules("agent('p', { label: 'impl:x', ...LADDER[ 4 ] })")).toEqual([])
  })

  test('R1: no spread but a ladder rung, whatever the kind', () => {
    // CHEAP may hold { model: 'haiku' }: the agent would run below the floor unseen.
    expect(rules("agent('p', { label: 'review:x', effort: 'high', ...CHEAP })")).toEqual(['R1'])
    expect(rules("agent('p', { label: 'decide:x', ...(LADDER[0]) })")).toEqual(['R1'])
    // BIG may hold { model: 'opus' }: the agent would run above the ceiling unseen.
    expect(rules("agent('p', { label: 'chore:x', model: 'haiku', effort: 'low', ...BIG })")).toEqual(['R1'])
    expect(messages("agent('p', { label: 'verify:x', model: 'opus', effort: 'high', ...opts })")).toEqual([
      'R1 展開（...）は ...LADDER[n]（n は数字）だけにしてください（静的に確かめるため）',
    ])
    // fix may index the ladder with an expression, but takes no other spread.
    expect(messages('agent(p, { label: `fix:${n}`, ...LADDER[tier + 1], ...CHEAP })')).toEqual([
      'R1 展開（...）は ...LADDER[n] だけにしてください（静的に確かめるため）',
    ])
    expect(rules("agent('p', { label: 'fix:1', model: 'opus', effort: 'high', ...opts })")).toEqual(['R1'])
  })

  test('R2: each kind has a floor', () => {
    expect(rules("agent('p', { label: 'review:diff', model: 'sonnet', effort: 'xhigh' })")).toEqual(['R2'])
    expect(messages("agent('p', { label: 'review:diff', model: 'sonnet', effort: 'xhigh' })")).toEqual(['R2 review の下限は 上位・high です（現在 sonnet・xhigh）'])
    expect(rules("agent('p', { label: 'review:diff', effort: 'high' })")).toEqual([])
    expect(rules("agent('p', { label: 'verify:tests', ...LADDER[1] })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'verify:tests', model: 'sonnet', effort: 'high' })")).toEqual([])
    expect(rules("agent('p', { label: 'impl:x', model: 'haiku', effort: 'max' })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'decide:merge', model: 'claude-fable-5-1', effort: 'max' })")).toEqual([])
  })

  test('R2: each floor holds at its boundary, and no kind but chore has a ceiling', () => {
    expect(rules("agent('p', { label: 'impl:x', ...LADDER[1] })")).toEqual([])
    expect(rules("agent('p', { label: 'impl:x', model: 'sonnet', effort: 'low' })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'investigate:x', ...LADDER[1] })")).toEqual([])
    expect(rules("agent('p', { label: 'investigate:x', model: 'haiku', effort: 'max' })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'verify:x', model: 'sonnet', effort: 'medium' })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'review:x', effort: 'medium' })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'refute:x', model: 'opus', effort: 'high' })")).toEqual([])
    expect(rules("agent('p', { label: 'refute:x', model: 'sonnet', effort: 'max' })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'refute:x', ...LADDER[2] })")).toEqual([])
    expect(rules("agent('p', { label: 'decide:x', effort: 'medium' })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'decide:x', ...LADDER[1] })")).toEqual(['R2'])
    for (const kind of ['impl', 'investigate', 'verify', 'review', 'refute', 'decide']) {
      expect(rules(`agent('p', { label: '${kind}:x', ...LADDER[4] })`)).toEqual([])
    }
  })

  test('R3: chore has a ceiling, and an omitted model inherits the top tier', () => {
    expect(messages("agent('p', { label: 'chore:commit-5-10', effort: 'medium' })")).toEqual([
      'R3 chore の上限は sonnet・medium です（現在 上位・medium。model を省くと本体のモデルを引き継ぎます）',
    ])
    expect(rules("agent('p', { label: 'chore:commit', model: 'sonnet', effort: 'high' })")).toEqual(['R3'])
    expect(rules("agent('p', { label: 'chore:commit', ...LADDER[1] })")).toEqual([])
    expect(rules("agent('p', { label: 'chore:count', ...LADDER[0] })")).toEqual([])
  })

  test('mixed keys and a rung: the floor reads the weaker, the ceiling the stronger', () => {
    expect(rules("agent('p', { label: 'review:diff', model: 'opus', effort: 'high', ...LADDER[1] })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'chore:x', model: 'opus', ...LADDER[1] })")).toEqual(['R3'])
    // The effort axis: an explicit effort and a rung's effort may each win.
    expect(rules("agent('p', { label: 'verify:x', effort: 'high', ...LADDER[1] })")).toEqual(['R2'])
    expect(rules("agent('p', { label: 'chore:x', effort: 'high', ...LADDER[1] })")).toEqual(['R3'])
    // One key before the rung and the other after it: each key is read on its own.
    expect(messages("agent('p', { label: 'impl:x', model: 'opus', ...LADDER[1], effort: 'low' })")).toEqual([
      'R2 impl の下限は sonnet・medium です（現在 sonnet・low）',
    ])
    expect(messages("agent('p', { label: 'chore:x', model: 'haiku', ...LADDER[1], effort: 'max' })")).toEqual([
      'R3 chore の上限は sonnet・medium です（現在 sonnet・max）',
    ])
    // The ceiling names the stronger reading, and a rung that gives the model adds no note on inheriting.
    expect(messages("agent('p', { label: 'chore:x', model: 'opus', ...LADDER[1] })")).toEqual([
      'R3 chore の上限は sonnet・medium です（現在 上位・medium）',
    ])
    expect(messages("agent('p', { label: 'chore:x', ...LADDER[2] })")).toEqual(['R3 chore の上限は sonnet・medium です（現在 上位・high）'])
  })

  test('R5: fix moves up the ladder or runs on the top model at high or above', () => {
    expect(rules('agent(p, { label: `fix:${n}`, ...LADDER[Math.min(tier + 1, 4)] })')).toEqual([])
    expect(rules("agent('p', { label: 'fix:1', model: 'sonnet', effort: 'xhigh' })")).toEqual(['R5'])
    expect(rules("agent('p', { label: 'fix:1', model: 'opus', effort: 'high' })")).toEqual([])
    expect(rules("agent('p', { label: 'fix:1', effort: 'xhigh' })")).toEqual([])
    // Both halves count: the top model, and effort high or above.
    expect(rules("agent('p', { label: 'fix:1', model: 'opus', effort: 'medium' })")).toEqual(['R5'])
    expect(rules("agent('p', { label: 'fix:1', model: m, effort: 'high' })")).toEqual(['R5'])
    // R1 is not for fix: a fix with no weight at all is told to move up.
    expect(rules("agent('p', { label: 'fix:1' })")).toEqual(['R5'])
    expect(messages("agent('p', { label: 'fix:1', model: 'sonnet', effort: 'xhigh' })")).toEqual([
      'R5 fix は段を1つ以上上げてください（...LADDER[tier + 1] の展開か、上位モデル（opus か claude-fable-5-1）で effort high 以上）',
    ])
  })

  test('R4: unknown models and efforts are named', () => {
    expect(rules("agent('p', { label: 'impl:x', effort: 'extreme' })")).toEqual(['R4'])
    expect(rules("agent('p', { label: 'impl:x', model: 'gpt-5', effort: 'high' })")).toEqual(['R4'])
    // Fable is written as its full id: the alias is unverified.
    expect(rules("agent('p', { label: 'impl:x', model: 'fable', effort: 'high' })")).toEqual(['R4'])
    expect(rules("agent('p', { label: 'impl:x', model: 'claude-fable-5-1', effort: 'high' })")).toEqual([])
  })

  test('R4: a claude- id outside the known families has no tier and is sent back', () => {
    expect(rules("agent('p', { label: 'review:x', model: 'claude-3-5-haiku-latest', effort: 'high' })")).toEqual(['R4'])
    expect(rules("agent('p', { label: 'chore:x', model: 'claude-3-opus-latest', effort: 'max' })")).toEqual(['R4'])
    expect(rules("agent('p', { label: 'fix:1', model: 'claude-3-opus-latest', effort: 'max' })")).toEqual(['R4'])
    expect(rules("agent('p', { label: 'scan', model: 'claude-instant-1', effort: 'low' })")).toEqual(['R4', 'R0'])
    expect(messages("agent('p', { label: 'review:x', model: 'claude-3-5-haiku-latest', effort: 'high' })")).toEqual([
      'R4 model「claude-3-5-haiku-latest」は格（haiku / sonnet / 上位）が分かりません。haiku / sonnet / opus か、claude-haiku- / claude-sonnet- / claude-opus- / claude-fable- / claude-mythos- で始まる正式IDにしてください',
    ])
    expect(rules("agent('p', { label: 'review:x', model: 'claude-mythos-1', effort: 'high' })")).toEqual([])
  })

  test('the deny text lists each violation in Japanese', () => {
    const text = formatDeny(
      checkCalls(scanAgentCalls("agent('a', { label: 'chore:a', effort: 'low', model: 'sonnet' }); agent('b', { label: 'review:diff', model: 'sonnet', effort: 'xhigh' }); agent('c', { effort: 'high' })")),
    )
    expect(text).toContain('quality-router: Workflow を差し戻しました（2件）。')
    expect(text).toContain('- 2番目の agent（review:diff）: review の下限は 上位・high です（現在 sonnet・xhigh）')
    expect(text).toContain('- 3番目の agent（ラベルなし）: ラベルの頭に種類（chore: / impl: / investigate: / verify: / review: / refute: / decide: / fix:）のいずれかを付けてください')
    expect(text.split('\n').at(-1)).toBe('直したら Workflow をもう一度呼んでください。種類と段（LADDER）の定義はシステムプロンプトの quality-router 節にあります。')
  })

  test('only scripts under this session folder count as written by the session', () => {
    const id = '6dda1a68-ea31-4c9f-8aff-625834942c7d'
    expect(isSessionScriptPath(`C:\\Users\\u\\.claude\\projects\\C--work-app\\${id}\\workflows\\scripts\\a.js`, id)).toBe(true)
    expect(isSessionScriptPath('C:/work/app/.claude/workflows/release-build.js', id)).toBe(false)
  })

  test('the guidance teaches the kinds and the ladder for the chosen top model', () => {
    const text = guidanceText('opus')
    for (const kind of ['chore:', 'impl:', 'investigate:', 'verify:', 'review:', 'refute:', 'decide:', 'fix:']) expect(text).toContain(`- ${kind}`)
    expect(text).not.toContain('- light:')
    const line = (kind: string) => text.split('\n').find(one => one.startsWith(`- ${kind}:`)) ?? ''
    expect(line('chore')).toContain('From haiku·low up to sonnet·medium')
    for (const kind of ['impl', 'investigate']) expect(line(kind)).toContain('At least sonnet·medium')
    expect(line('verify')).toContain('At least sonnet·high')
    for (const kind of ['review', 'refute', 'decide']) expect(line(kind)).toContain('At least the top model at high')
    expect(line('fix')).toContain('Move at least one rung up with ...LADDER[tier + 1]')
    expect(text).toContain('Omitting model inherits the session model, which counts as the top tier.')
    expect(text).toContain('...LADDER[tier + 1]')
    expect(text).toContain('Mechanical failures (timeout, API error, malformed output) retry on the same rung.')
    expect(text).toContain('After two escalations without a pass, end the workflow and hand the decision back to the user.')
    expect(text).toContain('inline as an object literal')
    expect(text).toContain('and so is any spread but ...LADDER[n]')
    expect(text).toContain("  { model: 'haiku', effort: 'low' }, // 0\n  { model: 'sonnet', effort: 'medium' }, // 1")
    expect(text).toContain("{ model: 'opus', effort: 'max' }, // 4")
    expect(guidanceText('fable')).toContain("{ model: 'claude-fable-5-1', effort: 'max' }, // 4")
  })
})
