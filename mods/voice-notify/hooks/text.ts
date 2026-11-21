// Shaping text for speech, as pure functions (moved from 0.2.0's notify.ps1
// and lib.ps1).

import type { SpeechConfig } from './config'

export type StopCase = 'ask' | 'trouble' | 'done'
export type ReadingConfig = Pick<SpeechConfig, 'readings' | 'lowercaseMinLength' | 'keepUppercase'>

// A run of over 200 characters with no end mark matches only by its last 200:
// the matches are not always the whole text up to the last one's end.
const SENTENCE = /[^。！？!?]{1,200}[。！？!?]/g

// Drops what does not read aloud: code blocks, tables, link targets, URLs.
function stripMarkup(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*\|.*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim()

// A summary told to use no marks may still copy the answer's Markdown.
export function clearSpeech(t: string): string {
  return squash(t.replace(/[`*_#>|[\]]/g, ' '))
}

// The first one or two sentences: the second joins a first of up to
// `shortMax` characters, unless the two pass `twoMax` together.
export function pickSentence(txt: string, opt: { shortMax: number; twoMax: number }): string | null {
  if (!txt) return null
  const t = squash(stripMarkup(txt).replace(/[`*#>_-]/g, ' '))
  if (t.length < 4) return null
  const found = [...t.matchAll(SENTENCE)]
  const first = found[0]
  // No sentence end, or none within the first sentence's 200 characters (the
  // first match then begins in its middle): the first 60 characters.
  if (!first || /[^。！？!?\s]/.test(t.slice(0, first.index))) return `${t.slice(0, 60)}。`
  const s1 = first[0]
  const second = found[1]
  // The second joins only when it follows at once (not past a long run).
  if (second && s1.length <= opt.shortMax && second.index === (first.index ?? 0) + s1.length) {
    const two = s1 + second[0]
    if (two.length <= opt.twoMax) return two
  }
  return s1
}

// The kind of answer, which picks the phrase that leads it, from its last two
// sentences only: "当初はエラーで停止していました。…修正して全件通っています。"
// is not trouble.
export function stopCase(txt: string): StopCase {
  if (!txt) return 'done'
  const t = squash(stripMarkup(txt).replace(/[`*#>_]/g, ' '))
  if (t.length < 2) return 'done'
  const found = [...t.matchAll(SENTENCE)]
  const sentences = found.map(m => m[0])
  const last = found[found.length - 1]
  // What follows the last sentence end, from where the last match ends (the
  // matches' joined length falls short of it past a long run).
  const rest = t.slice(last ? (last.index ?? 0) + last[0].length : 0).trim()
  const parts = rest.length >= 4 ? [...sentences, rest] : sentences
  const tail = parts.slice(-2).join('') || t
  if (/[?？]\s*$/.test(tail)) return 'ask'
  if (/(ますか|ましょうか|でしょうか|いかがですか|どうしますか|どうするか)[。．!！?？]?\s*$/.test(tail)) return 'ask'
  if (/(ご判断|ご確認ください|お選びください|お決めください|ご指示|どちらに|どちらで|番号で|教えてください|よろしいですか|いかがでしょう)/.test(tail)) return 'ask'
  // A problem said to be solved is struck out before looking for one that is
  // not ("エラーを修正しました" is done). So is one said not to be there
  // ("エラーはありませんでした"), each on its own: another that is there
  // still counts. "エラーがなくなりません" is not such a one.
  const chk = tail
    .replace(/(失敗|エラー|不具合|例外|問題)[をがはも]?[^。]{0,8}?(修正|解決|直し|直り|対処|復旧|解消|通るように)/g, '')
    .replace(/(失敗|エラー|不具合|例外|問題)[はもが]?((なく|無く)(?!な)|ありません|なし|無し|出ていません|出ません|起きていません|起きません|発生していません|発生しません|見つかりません|見つかっていません|していません|しません)/g, '')
  if (/(失敗|エラー|不具合|例外|できませんでした|できていません|通りません|落ちて|未解決|解決していません|原因が分から|うまくいかな|うまくいっていません)/.test(chk)) return 'trouble'
  return 'done'
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// VOICEVOX spells out Latin letters it has no entry for. The dictionary
// replaces words first; then long all-caps words go lowercase to be read as
// English words. A word with a letter, digit or _ beside it is left alone
// (\b would count Japanese as word characters).
export function convertReading(text: string, r: ReadingConfig): string {
  if (!text) return text
  let out = text
  for (const [word, reading] of Object.entries(r.readings)) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escape(word)}(?![A-Za-z0-9_])`, 'gi'), () => reading)
  }
  if (r.lowercaseMinLength > 0) {
    const keep = new Set(r.keepUppercase)
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])[A-Z]{${r.lowercaseMinLength},}(?![A-Za-z0-9_])`, 'g'), w => (keep.has(w) ? w : w.toLowerCase()))
  }
  return out
}

// Haiku may lead with "要約文：" or add a second line (seen 2026-10-06).
export function cleanSummary(raw: string, maxChars: number): { text: string } | { error: string } {
  const lines = raw.split(/\r?\n/).map(s => s.replace(/^\s*(要約|報告)文?\s*[:：]/, '').replace(/\s+/g, ' ').trim())
  const text = lines.find(s => s.length > 0) ?? ''
  if (!text) return { error: 'empty-reply' }
  if (text.length > maxChars * 3) return { error: `too-long (${text.length})` }
  return { text }
}
