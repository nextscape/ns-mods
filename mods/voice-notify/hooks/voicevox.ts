// Talking to the VOICEVOX ENGINE (127.0.0.1), as pure functions; engine.ts
// runs them. audio_query answers JSON, so $.http.fetch asks it; synthesis
// answers a WAV, which $.http.fetch cannot take (text only), so curl writes it
// to a file.

import type { Config } from './config'
import type { Voice } from './decide'
import { psArgv, slashPath, winPath } from './os'
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

const base = (port: number) => `http://127.0.0.1:${port}`

export function synthParams(cfg: Config, voice: Voice, root: string, os: Os): SynthParams {
  return {
    root,
    os,
    port: cfg.enginePort,
    speakerId: voice.id,
    speed: cfg.speedScale,
    pitch: cfg.pitchScale,
    intonation: cfg.intonationScale,
    leadMs: cfg.playback.leadSilenceMs,
  }
}

// FNV-1a (32 bit) twice with different seeds. Only names cache files, so
// collisions need no guarding against.
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

// When the default output is a display's audio (HDMI, DisplayPort), the start
// of a clip is lost. 0.2.0 put silence before the WAV when playing it; the mod
// cannot write binary, so the silence goes in at synthesis.
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

// The cached clip: the same text with every voice setting the same is the
// same file.
export function cachePath(p: SynthParams, text: string): string {
  return `${p.root}/cache/${hash16([text, p.speakerId, p.speed, p.pitch, p.intonation, p.leadMs].join('|'))}.wav`
}

export function versionUrl(port: number): string {
  return `${base(port)}/version`
}

export function audioQueryUrl(p: SynthParams, text: string): string {
  return `${base(p.port)}/audio_query?text=${encodeURIComponent(text)}&speaker=${p.speakerId}`
}

// The query goes on stdin (no temporary file to make and delete). No
// --create-dirs: Windows' own curl cannot make a folder with a non-ASCII name
// (exit 23), so the caller makes the folder first.
export function synthArgv(p: SynthParams, out: string): string[] {
  return [
    p.os === 'windows' ? 'curl.exe' : 'curl', '-s', '-f', '-m', '120', '-H', 'Content-Type: application/json',
    '--data-binary', '@-', '-o', out, `${base(p.port)}/synthesis?speaker=${p.speakerId}`,
  ]
}

// /version answers a JSON string ("0.25.2").
export function parseVersion(text: string): string | null {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

// The cached clips past the newest `max`. A cache hit cannot touch the file's
// time ($.fs cannot rewrite binary), so the oldest made go first.
export function cacheToDrop(entries: ReadonlyArray<{ name: string; kind: string; mtimeMs: number }>, root: string, max: number): string[] {
  return entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.wav'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(max)
    .map(f => `${root}/cache/${f.name}`)
}

// ---- Where the engine is and how it starts (setup) ----

// `path` null: where it is is unknown, but it answers (Docker, or started by
// hand).
export type FoundEngine = { path: string | null; running: boolean }

export function engineCandidates(os: Os, env: { LOCALAPPDATA?: string; ProgramFiles?: string; HOME?: string }, wingetDirs: readonly string[]): string[] {
  if (os === 'windows') {
    const local = env.LOCALAPPDATA ? slashPath(env.LOCALAPPDATA) : null
    return [
      ...(local ? wingetDirs.map(d => `${local}/Microsoft/WinGet/Packages/${d}/VOICEVOX/vv-engine/run.exe`) : []),
      ...(local ? [`${local}/Programs/VOICEVOX/vv-engine/run.exe`] : []),
      ...(env.ProgramFiles ? [`${slashPath(env.ProgramFiles)}/VOICEVOX/vv-engine/run.exe`] : []),
    ]
  }
  const home = env.HOME ? slashPath(env.HOME) : null
  if (os === 'macos') {
    // Where it sits inside the .app may change between versions: both places.
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

// Started apart from the session ($.process.spawn's children end with the
// module). Windows runs start-engine.ps1, the script the logon task runs,
// which waits for the engine and answers by its exit code. Elsewhere nohup
// detaches it and the caller waits for it to answer.
export function startArgv(os: Os, pluginRoot: string, exe: string): string[] {
  if (os === 'windows') return psArgv(pluginRoot, 'start-engine.ps1', ['-EnginePath', winPath(exe), '-Quiet'])
  return ['sh', '-c', 'cd "$(dirname "$1")" && nohup "$1" >/dev/null 2>&1 &', 'sh', exe]
}
