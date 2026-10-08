// 読み上げ用の整形。$ に触れない純粋関数だけを置く（0.2.0 の notify.ps1 / lib.ps1 から移した）。

export type StopCase = 'ask' | 'trouble' | 'done'
export type ReadingConfig = { readings?: Record<string, string>; lowercaseMinLength?: number; keepUppercase?: string[] }

const SENTENCE = /[^。！？!?]{1,200}[。！？!?]/g

// 読み上げに向かない要素（コードブロック・表・リンク先・URL）を落とす
function stripMarkup(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*\|.*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim()

// 「記号は使わない」と指示しても、要約が本文の Markdown を写してくることがある
export function clearSpeech(t: string): string {
  return squash(t.replace(/[`*_#>|[\]]/g, ' '))
}

// 先頭の1〜2文。先頭1文が shortMax 以下なら2文目まで、ただし合計が twoMax を超えるなら1文だけ
export function pickSentence(txt: string, opt: { shortMax?: number; twoMax?: number } = {}): string | null {
  if (!txt) return null
  const t = squash(stripMarkup(txt).replace(/[`*#>_-]/g, ' '))
  if (t.length < 4) return null
  const sentences = t.match(SENTENCE) ?? []
  if (sentences.length === 0) return `${t.slice(0, 60)}。`
  const s1 = sentences[0]!
  const shortMax = opt.shortMax ?? 20
  const twoMax = opt.twoMax ?? 60
  if (s1.length <= shortMax && sentences.length >= 2) {
    const two = s1 + sentences[1]
    if (two.length <= twoMax) return two
  }
  return s1
}

// 前置きの定型フレーズを選ぶため、末尾2文だけを見て種類を決める。
// 末尾に限るのは「当初はエラーで停止していました。…修正して全件通っています。」を trouble にしないため
export function stopCase(txt: string): StopCase {
  if (!txt) return 'done'
  const t = squash(stripMarkup(txt).replace(/[`*#>_]/g, ' '))
  if (t.length < 2) return 'done'
  const sentences = t.match(SENTENCE) ?? []
  const rest = t.slice(Math.min(sentences.join('').length, t.length)).trim()
  const parts = rest.length >= 4 ? [...sentences, rest] : sentences
  const tail = parts.slice(-2).join('') || t
  if (/[?？]\s*$/.test(tail)) return 'ask'
  if (/(ますか|ましょうか|でしょうか|いかがですか|どうしますか|どうするか)[。．!！?？]?\s*$/.test(tail)) return 'ask'
  if (/(ご判断|ご確認ください|お選びください|お決めください|ご指示|どちらに|どちらで|番号で|教えてください|よろしいですか|いかがでしょう)/.test(tail)) return 'ask'
  // 解決済みの言及は打ち消してから未解決語を探す（「エラーを修正しました」は done）
  const chk = tail.replace(/(失敗|エラー|不具合|例外|問題)[をがはも]?[^。]{0,8}?(修正|解決|直し|直り|対処|復旧|解消|通るように)/g, '')
  if (/(失敗|エラー|不具合|例外|できませんでした|できていません|通りません|落ちて|未解決|解決していません|原因が分から|うまくいかな|うまくいっていません)/.test(chk)) return 'trouble'
  return 'done'
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// VOICEVOX は辞書に無い英字を1文字ずつ読む。辞書で置き換え、長い全部大文字の語は小文字にして英単語として読ませる。
// 前後が英数字か _ なら触らない（\b は日本語も単語文字に数えるので使えない）
export function convertReading(text: string, r: ReadingConfig): string {
  if (!text) return text
  let out = text
  for (const [word, reading] of Object.entries(r.readings ?? {})) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escape(word)}(?![A-Za-z0-9_])`, 'gi'), () => reading)
  }
  const min = r.lowercaseMinLength ?? 0
  if (min > 0) {
    const keep = new Set(r.keepUppercase ?? [])
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])[A-Z]{${min},}(?![A-Za-z0-9_])`, 'g'), w => (keep.has(w) ? w : w.toLowerCase()))
  }
  return out
}

// Haiku は「要約文：」のような前置きや2行目を付けることがある（2026-10-06 実測）
export function cleanSummary(raw: string, maxChars: number): { text: string } | { error: string } {
  const lines = raw.split(/\r?\n/).map(s => s.replace(/^\s*(要約|報告)文?\s*[:：]/, '').replace(/\s+/g, ' ').trim())
  const text = lines.find(s => s.length > 0) ?? ''
  if (!text) return { error: 'empty-reply' }
  if (text.length > maxChars * 3) return { error: `too-long (${text.length})` }
  return { text }
}
