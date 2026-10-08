// VOICEVOX ENGINE（127.0.0.1）との通信の形。実行は register.ts（$ を使えるのは hooks モジュールの中だけ）。
// audio_query は JSON なので $.http.fetch。synthesis は WAV（バイナリ）で $.http.fetch では受け取れないので curl でファイルに落とす。

import { enginePort } from './decide'
import type { Voice, VoiceConfig } from './decide'
import type { Os } from './os'

export type SynthParams = {
  root: string
  os: Os
  port: number
  speakerId: number
  speed: number
  pitch: number
  intonation: number
  leadMs: number
}

const win = (p: string) => p.replace(/\//g, '\\')
const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const base = (port: number) => `http://127.0.0.1:${port}`

export function synthParams(cfg: VoiceConfig, voice: Voice, root: string, os: Os): SynthParams {
  return {
    root,
    os,
    port: enginePort(cfg),
    speakerId: voice.id,
    speed: cfg.speedScale ?? 1,
    pitch: cfg.pitchScale ?? 0,
    intonation: cfg.intonationScale ?? 1,
    leadMs: cfg.playback?.leadSilenceMs ?? 600,
  }
}

// FNV-1a（32bit）を種違いで2回。キャッシュの名前に使うだけなので衝突耐性は要らない
function fnv(text: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function hash16(text: string): string {
  return fnv(text, 0x811c9dc5) + fnv(text, 0x050c5d1f)
}

// 既定の出力先がディスプレイの音声（HDMI/DisplayPort）だと鳴らし始めが欠ける。
// 0.2.0 は再生の前に WAV の頭へ無音を足していたが、mod はバイナリを書けないので、合成の時点で入れる
export function tuneQuery(raw: Record<string, unknown>, p: SynthParams): Record<string, unknown> {
  const pre = typeof raw.prePhonemeLength === 'number' ? raw.prePhonemeLength : 0.1
  return {
    ...raw,
    speedScale: p.speed,
    pitchScale: p.pitch,
    intonationScale: p.intonation,
    prePhonemeLength: Math.round((pre + p.leadMs / 1000) * 1000) / 1000,
  }
}

// 合成結果のキャッシュ。文と声の設定がすべて同じなら同じファイル
export function cachePath(p: SynthParams, text: string): string {
  return `${p.root}/cache/${hash16([text, p.speakerId, p.speed, p.pitch, p.intonation, p.leadMs].join('|'))}.wav`
}

export function versionUrl(port: number): string {
  return `${base(port)}/version`
}

export function audioQueryUrl(p: SynthParams, text: string): string {
  return `${base(p.port)}/audio_query?text=${encodeURIComponent(text)}&speaker=${p.speakerId}`
}

// クエリは stdin で渡す（一時ファイルを作って消す手間をかけない）。
// --create-dirs は使わない：Windows 標準の curl は非 ASCII のフォルダを作れない（exit 23）ので、フォルダは呼ぶ側が先に作る
export function synthArgv(p: SynthParams, out: string): string[] {
  return [
    p.os === 'windows' ? 'curl.exe' : 'curl', '-s', '-f', '-m', '120', '-H', 'Content-Type: application/json',
    '--data-binary', '@-', '-o', out, `${base(p.port)}/synthesis?speaker=${p.speakerId}`,
  ]
}

// /version は JSON の文字列（"0.25.2"）を返す
export function parseVersion(text: string): string | null {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

// 新しいものから max 件を残す。キャッシュに当たっても更新時刻は変えられない（$.fs はバイナリを書き直せない）ので、作った順に古いものから消える
export function cacheToDrop(entries: ReadonlyArray<{ name: string; kind: string; mtimeMs: number }>, root: string, max: number): string[] {
  return entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.wav'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(max)
    .map(f => `${root}/cache/${f.name}`)
}

// ---- ENGINE の場所と起動（setup が使う） ----

// path が null は「場所は分からないが応答はある」（Docker や手で起動した ENGINE）
export type FoundEngine = { path: string | null; running: boolean }

export function engineCandidates(os: Os, env: { LOCALAPPDATA?: string; ProgramFiles?: string; HOME?: string }, wingetDirs: readonly string[]): string[] {
  if (os === 'windows') {
    const local = env.LOCALAPPDATA ? slash(env.LOCALAPPDATA) : null
    return [
      ...(local ? wingetDirs.map(d => `${local}/Microsoft/WinGet/Packages/${d}/VOICEVOX/vv-engine/run.exe`) : []),
      ...(local ? [`${local}/Programs/VOICEVOX/vv-engine/run.exe`] : []),
      ...(env.ProgramFiles ? [`${slash(env.ProgramFiles)}/VOICEVOX/vv-engine/run.exe`] : []),
    ]
  }
  const home = env.HOME ? slash(env.HOME) : null
  if (os === 'macos') {
    // .app の中の位置は版で変わりうるので2通り試す
    return ['Resources', 'MacOS'].flatMap(d => [
      `/Applications/VOICEVOX.app/Contents/${d}/vv-engine/run`,
      ...(home ? [`${home}/Applications/VOICEVOX.app/Contents/${d}/vv-engine/run`] : []),
    ])
  }
  return [
    ...(home ? [`${home}/.voicevox/vv-engine/run`, `${home}/VOICEVOX/vv-engine/run`] : []),
    '/opt/voicevox/vv-engine/run',
    ...(home ? [`${home}/.local/share/voicevox/vv-engine/run`] : []),
  ]
}

// セッションから切り離して起動する（$.process.spawn の子はモジュールと一緒に終わる）。
// Windows はログオン時のタスクと同じ start-engine.ps1（起動を待って終了コードで答える）。それ以外は nohup で切り離し、呼ぶ側が応答を待つ
export function startArgv(os: Os, pluginRoot: string, exe: string): string[] {
  if (os === 'windows') {
    return [
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', win(`${pluginRoot}/scripts/windows/start-engine.ps1`),
      '-EnginePath', win(exe), '-Quiet',
    ]
  }
  return ['sh', '-c', 'cd "$(dirname "$1")" && nohup "$1" >/dev/null 2>&1 &', 'sh', exe]
}
