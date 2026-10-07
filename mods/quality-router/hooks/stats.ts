import { LEVELS } from './levels'
import type { MainRecord, QrRecord, SignalRecord, SubRecord, WfGateRecord } from './record'
import { SUB_KINDS } from './sub-route'

// /qr stats, a few English lines over the period's records.

export type Period = 'today' | '7d' | '30d'

const DAY = 86_400_000
const WAYS = ['auto', 'short', 'late', 'unsure', 'error'] as const

export function periodOf(arg: string): Period | null {
  if (arg === '') return '7d'
  return arg === 'today' || arg === '7d' || arg === '30d' ? arg : null
}

// today: since local midnight; the others: rolling days.
export function sinceOf(period: Period, now: number): number {
  if (period === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  return now - (period === '7d' ? 7 : 30) * DAY
}

// Lines that are not version-1 records are skipped.
export function parseRecords(text: string): QrRecord[] {
  const out: QrRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const o = JSON.parse(line) as { v?: unknown; kind?: unknown; at?: unknown }
      if (o && o.v === 1 && typeof o.kind === 'string' && typeof o.at === 'string') out.push(o as QrRecord)
    } catch {
      // A torn or foreign line.
    }
  }
  return out
}

const pct = (n: number, total: number) => `${Math.round((n * 100) / total)}%`
const amount = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

export function summarize(records: QrRecord[], period: Period): string {
  const main = records.filter((r): r is MainRecord => r.kind === 'main')
  const subs = records.filter((r): r is SubRecord => r.kind === 'sub')
  const gates = records.filter((r): r is WfGateRecord => r.kind === 'wf' && r.phase === 'gate')
  const signals = records.filter((r): r is SignalRecord => r.kind === 'signal')
  if (main.length === 0 && subs.length === 0 && gates.length === 0) return `stats ${period}: まだ記録がありません。`

  const lines = [`stats ${period}: main ${main.length} turns, sub ${subs.length}, workflow ${gates.length}`]
  if (main.length > 0) {
    const levels = LEVELS.map(l => `${l} ${pct(main.filter(r => r.level === l).length, main.length)}`).join(' · ')
    const ways = WAYS.map(w => [w, main.filter(r => r.why === w).length] as const)
      .filter(([, n]) => n > 0)
      .map(([w, n]) => `${w} ${pct(n, main.length)}`)
      .join(', ')
    lines.push(`main: ${levels}  (${ways})`)
  }

  const count = (pred: (s: SignalRecord) => boolean) => signals.filter(pred).length
  const overUp = count(s => s.type === 'override' && s.dir === 'up')
  const qrUp = count(s => s.type === 'feedback' && s.dir === 'up')
  const bumps = main.filter(r => r.bump).length
  const errors = main.filter(r => !r.bump && r.toolErrors >= 2).length
  const overDown = count(s => s.type === 'override' && s.dir === 'down')
  const qrDown = count(s => s.type === 'feedback' && s.dir === 'down')
  lines.push(
    `shallow signals ${overUp + qrUp + bumps + errors} (override up ${overUp}, /qr up ${qrUp}, bump ${bumps}, tool errors ${errors})` +
      ` · heavy signals ${overDown + qrDown} (override down ${overDown}, /qr down ${qrDown})`,
  )

  const byLevel = LEVELS.map(l => [l, main.filter(r => r.level === l).reduce((n, r) => n + (r.tokens?.output ?? 0), 0)] as const).filter(([, n]) => n > 0)
  if (byLevel.length > 0) lines.push(`tokens by level (output): ${byLevel.map(([l, n]) => `${l} ${amount(n)}`).join(' · ')}`)

  if (subs.length > 0) {
    const kinds = SUB_KINDS.map(k => [k, subs.filter(r => r.kindJudged === k).length] as const).filter(([, n]) => n > 0)
    const explicit = subs.filter(r => r.why === 'explicit' || r.why === 'off').length
    const parts = [...kinds.map(([k, n]) => `${k} ${n}`), ...(explicit > 0 ? [`explicit ${explicit}`] : [])]
    lines.push(`sub: ${parts.join(' · ')} (retry ${subs.filter(r => r.why === 'retry').length}, unsure ${subs.filter(r => r.why === 'unsure').length})`)
  }
  if (gates.length > 0) {
    lines.push(`workflow: deny ${gates.filter(r => r.verdict === 'deny').length} · fix ${gates.reduce((n, r) => n + r.fixes, 0)}`)
  }
  return lines.join('\n')
}
