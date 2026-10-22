// The engine beneath the mod in tests: each $ call answered with { value }.
// Files live in a Map, processes are recorded and answered by their argv,
// HTTP plays the engine, and the model gives a fixed reply.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { resolveConfig } from '../hooks/config'

export const ROOT = 'C:/vn'

// The test runtime has setTimeout, but the mod's types (ES only) do not:
// declared here, once.
declare function setTimeout(callback: () => void, ms: number): unknown

// Waits in real time (not on the test clock), to see clips overlap or not.
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export type RunResult = { exitCode?: number; stdout?: string; stderr?: string }
export type Agent = { id: string; description: string; type: string; status: 'running' | 'completed' | 'idle' }
export type Reply = { isAnswered: true; text: string } | { isAnswered: false; reason: 'api-error'; status: number; error: string }

export type WorldOptions = {
  os?: 'windows' | 'macos' | 'linux'
  // The home's config.json: null for none, an object written as JSON.
  config?: Record<string, unknown> | string | null
  files?: Record<string, string>
  engine?: boolean
  agents?: Agent[]
  reply?: Reply
  // Asked before the default answers; undefined leaves it to them.
  run?: (argv: readonly string[]) => RunResult | undefined
  linuxPlayers?: string[]
  // Commands that cannot start (not installed): $.process.run rejects.
  missing?: string[]
  // fs.exists throws (a place that cannot be read).
  existsFails?: boolean
  // $.model.complete throws.
  modelThrows?: boolean
  // How long a clip plays, in real ms, to see clips overlap or not.
  playMs?: number
  now?: number
  // Added to VOICE_NOTIFY_HOME and OS.
  env?: Record<string, string>
}

export type World = {
  files: Map<string, string>
  mtimes: Map<string, number>
  runs: string[][]
  fetches: Array<{ url: string; method: string; body?: string }>
  asks: Array<Record<string, unknown>>
  played: string[]
  // The most clips playing at once.
  maxPlaying: number
  // Each process.run's stdin, in the order of `runs`.
  inputs: string[]
  // What $.command.register registered: the names, and each registration.
  commands: string[]
  registrations: Array<Record<string, unknown>>
  agents: Agent[]
  clock: ReturnType<typeof mock.clock>
}

// The engine may hand fs paths with Windows separators: compared with / only.
// Run on Windows, a macOS or Linux absolute path (/Users/…, /home/…) arrives
// with a drive letter, which goes too.
export const key = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/(Users|home|Applications|opt)\/)/, '')

export const AUDIO_QUERY = { accent_phrases: [], speedScale: 1, pitchScale: 0, intonationScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1 }

// The person's config.json in most tests; what it leaves out runs at its default.
export const USER_CONFIG = {
  speaker: 'metan',
  speakerInterim: 'zundamon',
  speedScale: 1.3,
  speakers: { metan: { id: 2, label: 'めたん' }, zundamon: { id: 3, label: 'ずんだもん' } },
  speech: { readings: { FIX: 'フィックス' } },
  mute: { whenMicInUse: false },
  notification: { toolLabels: { Bash: 'コマンド実行' } },
}

// The settings the mod runs with for USER_CONFIG.
export const CFG = resolveConfig(USER_CONFIG)

// A config.json with few phrases: 7 per voice, 14 in all. Folders the
// defaults have and these do not are emptied, or they would lay over them.
export const PHRASE_USER = {
  ...USER_CONFIG,
  phrases: {
    stop: { done: ['完了しました。', 'できました。'], ask: [], trouble: [], solo: [], interim: [], brief: { done: ['終わりました。'], ask: [], trouble: [], interim: [] } },
    notification: [],
    task: [],
    permission: [],
    idle: ['入力をお待ちしています。'],
    failure: [],
    mute: ['停止します。'],
    unmute: ['再開します。'],
  },
}

export const PHRASE_CFG = resolveConfig(PHRASE_USER)

// The plugin's own files (under $.plugin.root), answered by the end of the path.
const SHIPPED: Record<string, string> = {
  '/scripts/macos/voice-notify-engine.plist': '<string>{{LABEL}}</string><string>{{RUN}}</string><string>{{DIR}}</string>',
  '/scripts/linux/voice-notify-engine.service': 'WorkingDirectory={{DIR}}\nExecStart="{{RUN}}"\n',
}

export function world(on: On, opts: WorldOptions = {}): World {
  const os = opts.os ?? 'windows'
  mock.store(on)
  const clock = mock.clock(on, { now: opts.now ?? 1_000_000 })
  mock.env(on, { VOICE_NOTIFY_HOME: ROOT, ...(os === 'windows' ? { OS: 'Windows_NT' } : {}), ...(opts.env ?? {}) })
  const files = new Map<string, string>(Object.entries(opts.files ?? {}).map(([k, v]) => [key(k), v]))
  const mtimes = new Map<string, number>()
  if (opts.config !== null) {
    const c = opts.config ?? USER_CONFIG
    files.set(`${ROOT}/config.json`, typeof c === 'string' ? c : JSON.stringify(c))
  }
  const w: World = { files, mtimes, runs: [], fetches: [], asks: [], played: [], maxPlaying: 0, inputs: [], commands: [], registrations: [], agents: opts.agents ?? [], clock }
  const engine = opts.engine ?? true
  let playing = 0
  const players = opts.linuxPlayers ?? ['pw-play']
  const ok = (r: RunResult = {}) => ({
    value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  // A write is timed on the test clock, so clock.advance can show the
  // debounce and the like.
  const put = (path: string, text: string) => {
    files.set(key(path), text)
    mtimes.set(key(path), clock.now())
  }
  const move = (from: string | undefined, to: string | undefined) => {
    if (files.has(from!)) put(to!, files.get(from!)!)
    files.delete(from!)
  }

  on('session.id', async () => ({ value: 'sess-1' }))
  on('ui.log', async () => ({ value: undefined }))
  on('fs.read', async ($, e) => {
    const p = key(e.path)
    const t = files.get(p) ?? Object.entries(SHIPPED).find(([suffix]) => p.endsWith(suffix))?.[1]
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t } as never
  })
  on('fs.write', async ($, e) => {
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', async ($, e) => {
    if (opts.existsFails) throw new Error(`EACCES ${e.path}`)
    const p = key(e.path)
    return { value: files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)) }
  })
  on('fs.stat', async ($, e) => {
    const p = key(e.path)
    if (!files.has(p)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: files.get(p)!.length, mtimeMs: mtimes.get(p) ?? 0, isLink: false } } as never
  })
  on('fs.list', async ($, e) => {
    const dir = `${key(e.path)}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of files.keys()) {
      if (!k.startsWith(dir)) continue
      const rest = k.slice(dir.length)
      const slash = rest.indexOf('/')
      names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir')
    }
    if (names.size === 0) throw new Error(`ENOENT ${e.path}`)
    return {
      value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: mtimes.get(`${dir}${name}`) ?? 0, isLink: false })),
    } as never
  })
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    w.inputs.push(e.init?.stdin ?? '')
    if (opts.missing?.includes(argv[0]!)) throw new Error(`spawn ${argv[0]} ENOENT`)
    const custom = opts.run?.(argv)
    if (custom) return ok(custom) as never
    // Windows names curl.exe and powershell.exe: compared without .exe.
    const cmd = argv[0]!.replace(/\.exe$/i, '')
    const script = cmd === 'powershell' ? (argv.at(-1) ?? '').replace(/^.*[\\/]/, '') : ''
    if (cmd === 'uname') return ok({ stdout: os === 'macos' ? 'Darwin\n' : 'Linux\n' }) as never
    if (cmd === 'sh' && argv[2]?.startsWith('command -v ')) {
      const name = argv[2].slice('command -v '.length).trim()
      return ok(players.includes(name) ? { stdout: `/usr/bin/${name}\n` } : { exitCode: 1 }) as never
    }
    if (cmd === 'curl') {
      if (argv[1] === '--version') return ok({ stdout: 'curl 8.0.0\n' }) as never
      if (!engine) return ok({ exitCode: 7, stderr: 'Failed to connect' }) as never
      put(argv[argv.indexOf('-o') + 1]!, 'RIFF-fake-wav')
      return ok() as never
    }
    // mv -f -- <from> <to>, or move.ps1 with the two paths on stdin.
    if (cmd === 'mv') {
      const [from, to] = argv.slice(3).map(key)
      move(from, to)
      return ok() as never
    }
    if (script === 'move.ps1') {
      const [from, to] = (e.init?.stdin ?? '').split('\n').map(key)
      move(from, to)
      return ok() as never
    }
    // rm -f -- <paths>, or remove.ps1 with the paths on stdin, one per line.
    if (cmd === 'rm') {
      for (const a of argv.slice(3)) files.delete(key(a))
      return ok() as never
    }
    if (script === 'remove.ps1') {
      for (const a of (e.init?.stdin ?? '').split('\n')) if (a) files.delete(key(a))
      return ok() as never
    }
    // Playing (Windows: powershell, macOS: afplay, Linux: the sh script): the
    // wav is always argv's last.
    if (cmd === 'powershell' || cmd === 'afplay' || cmd === 'sh') {
      w.played.push(key(argv[argv.length - 1]!))
      playing++
      w.maxPlaying = Math.max(w.maxPlaying, playing)
      try {
        if (opts.playMs) await delay(opts.playMs)
      } finally {
        playing--
      }
      return ok() as never
    }
    return ok() as never
  })
  on('http.fetch', async ($, e) => {
    const method = e.init?.method ?? 'GET'
    w.fetches.push({ url: e.url, method, body: e.init?.body })
    if (!engine) throw new Error('ECONNREFUSED')
    const text = e.url.includes('/version') ? '"0.25.2"' : e.url.includes('/audio_query') ? JSON.stringify(AUDIO_QUERY) : ''
    return { value: { status: 200, ok: true, headers: {}, text } } as never
  })
  on('agent.list', async () => ({ value: w.agents }) as never)
  // The engine's own part (what the mod's hooks reach with next(e)).
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('classic.PermissionRequest', async () => ({}) as never)
  on('classic.Notification', async () => ({}) as never)
  on('classic.TaskCompleted', async () => ({}) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async ($, e) => {
    w.commands.push(e.name)
    w.registrations.push(e as unknown as Record<string, unknown>)
    return { value: { command: e.name } } as never
  })
  on('model.complete', async ($, e) => {
    w.asks.push(e as unknown as Record<string, unknown>)
    if (opts.modelThrows) throw new Error('model unavailable')
    return { value: { ...(opts.reply ?? { isAnswered: true, text: '要約しました。' }), usage: { input_tokens: 0, output_tokens: 0 } } } as never
  })
  return w
}
