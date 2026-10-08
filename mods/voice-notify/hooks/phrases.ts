// 定型フレーズの一覧と、作り直しが要るかの判定（純粋関数）。生成の I/O は register.ts。

import type { VoiceConfig } from './decide'
import { hash16 } from './voicevox'

export type PhraseJob = { speaker: string; path: string; text: string }
export type PhraseState = { total: number; missing: number; current: boolean; busy: boolean; progress: { done: number; total: number } | null }

// 生成中の記録がこれより新しければ、別のセッションが作っているとみなす
const BUSY_MS = 120_000

// フレーズ定義は配列（<dir>/NN.wav）か、サブフォルダに分けるオブジェクト（0.2.0 の gen-phrases.ps1 と同じ並び）
function walk(node: unknown, dir: string, speaker: string, out: PhraseJob[]): void {
  if (Array.isArray(node)) {
    node.forEach((text, i) => out.push({ speaker, path: `${dir}/${String(i + 1).padStart(2, '0')}.wav`, text: String(text) }))
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, `${dir}/${k}`, speaker, out)
  }
}

export function phraseJobs(cfg: VoiceConfig, root: string): PhraseJob[] {
  const out: PhraseJob[] = []
  for (const speaker of Object.keys(cfg.speakers ?? {})) {
    walk(cfg.phrases ?? {}, `${root}/phrases/${speaker}`, speaker, out)
    // 説明も報告も取れなかったサブエージェントの完了。0.2.0 は agent/_default.wav というファイルだったが、
    // 再生はフォルダから選ぶので、ほかのフレーズと同じ形（フォルダの中の NN.wav）にそろえる
    out.push({ speaker, path: `${root}/phrases/${speaker}/agent/_default/01.wav`, text: `${cfg.subagent?.defaultLabel ?? 'エージェント'}が完了しました。` })
  }
  return out
}

// 作ったフレーズがどの設定のものか。文言・話者・話速・読み替え・先頭の無音のどれかが変われば変わる
export function jobsStamp(jobs: readonly PhraseJob[], cfg: VoiceConfig): string {
  const sp = cfg.speech ?? {}
  const voice = JSON.stringify([
    cfg.speakers ?? {}, cfg.speedScale, cfg.pitchScale, cfg.intonationScale, cfg.playback?.leadSilenceMs ?? 600,
    sp.readings ?? {}, sp.lowercaseMinLength ?? 0, sp.keepUppercase ?? [],
  ])
  return hash16(`${voice}\n${jobs.map(j => `${j.path}\t${j.text}`).join('\n')}`)
}

export function phraseBusy(progress: { done: number; total: number; at: number } | null, now: number): boolean {
  return !!progress && progress.done < progress.total && now - progress.at < BUSY_MS
}
