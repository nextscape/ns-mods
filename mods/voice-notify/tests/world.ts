// テストのエンジンの下層。$ の各呼び出しを { value } で答える。
// fs は Map、プロセスは argv を記録して答える、HTTP は ENGINE のふり、モデルは固定の返答。
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const ROOT = 'C:/vn'

export type RunResult = { exitCode?: number; stdout?: string; stderr?: string }
export type Agent = { id: string; description: string; type: string; status: 'running' | 'completed' | 'idle' }
export type Reply = { isAnswered: true; text: string } | { isAnswered: false; reason: 'api-error'; status: number; error: string }

export type WorldOptions = {
  os?: 'windows' | 'macos' | 'linux'
  // ホームの config.json。null で置かない。オブジェクトは JSON にする
  config?: Record<string, unknown> | string | null
  files?: Record<string, string>
  engine?: boolean
  agents?: Agent[]
  reply?: Reply
  // 既定の答えより先に見る。undefined を返せば既定に任せる
  run?: (argv: readonly string[]) => RunResult | undefined
  linuxPlayers?: string[]
  now?: number
  // VOICE_NOTIFY_HOME と OS に足す環境変数
  env?: Record<string, string>
}

export type World = {
  files: Map<string, string>
  mtimes: Map<string, number>
  runs: string[][]
  fetches: Array<{ url: string; method: string; body?: string }>
  asks: Array<Record<string, unknown>>
  played: string[]
  // 各 process.run の stdin（runs と同じ並び）
  inputs: string[]
  // $.command.register で登録された名前
  commands: string[]
  agents: Agent[]
  clock: ReturnType<typeof mock.clock>
}

// エンジンは fs のパスを Windows の区切り（\）にして渡すことがあるので、比べる前に / にそろえる。
// また Windows でテストを動かすと、macOS・Linux の絶対パス（/Users/…・/home/… など）にドライブ名が付いて届くので外す
export const key = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/(Users|home|Applications|opt)\/)/, '')

export const AUDIO_QUERY = { accent_phrases: [], speedScale: 1, pitchScale: 0, intonationScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1 }

export const DEFAULT_CONFIG = {
  speaker: 'metan',
  speakerInterim: 'zundamon',
  speedScale: 1.3,
  pitchScale: 0,
  intonationScale: 1,
  enginePort: 50021,
  speakers: { metan: { id: 2, label: 'めたん' }, zundamon: { id: 3, label: 'ずんだもん' } },
  subagent: { debounceSeconds: 8 },
  speech: {
    summarize: true,
    summarizeEvents: ['stop', 'agentstop'],
    summaryMinChars: 80,
    summaryMaxChars: 60,
    interimMaxChars: 30,
    summaryTimeoutSec: 15,
    briefMaxSeconds: 30,
    readings: { FIX: 'フィックス' },
    lowercaseMinLength: 5,
  },
  mute: { whenMicInUse: false },
  cacheMaxFiles: 200,
  playback: { leadSilenceMs: 600 },
  notification: { toolLabels: { Bash: 'コマンド実行' } },
}

// プラグインに同梱のファイル（$.plugin.root の下）。パスの末尾で答える
const SHIPPED: Record<string, string> = {
  '/config.default.json': JSON.stringify(DEFAULT_CONFIG),
  '/scripts/macos/voice-notify-engine.plist': '<string>{{LABEL}}</string><string>{{RUN}}</string><string>{{DIR}}</string>',
  '/scripts/linux/voice-notify-engine.service': 'WorkingDirectory={{DIR}}\nExecStart="{{RUN}}"\n',
}

// フレーズの少ない設定（2話者 × 7件 = 14件）
export const PHRASE_CFG = {
  ...DEFAULT_CONFIG,
  phrases: { idle: ['入力をお待ちしています。'], stop: { done: ['完了しました。', 'できました。'], brief: { done: ['終わりました。'] } }, mute: ['停止します。'], unmute: ['再開します。'] },
  subagent: { debounceSeconds: 8, defaultLabel: 'エージェント' },
}

export function world(on: On, opts: WorldOptions = {}): World {
  const os = opts.os ?? 'windows'
  mock.store(on)
  const clock = mock.clock(on, { now: opts.now ?? 1_000_000 })
  mock.env(on, { VOICE_NOTIFY_HOME: ROOT, ...(os === 'windows' ? { OS: 'Windows_NT' } : {}), ...(opts.env ?? {}) })
  const files = new Map<string, string>(Object.entries(opts.files ?? {}).map(([k, v]) => [key(k), v]))
  const mtimes = new Map<string, number>()
  if (opts.config !== null) {
    const c = opts.config ?? DEFAULT_CONFIG
    files.set(`${ROOT}/config.json`, typeof c === 'string' ? c : JSON.stringify(c))
  }
  const w: World = { files, mtimes, runs: [], fetches: [], asks: [], played: [], inputs: [], commands: [], agents: opts.agents ?? [], clock }
  const engine = opts.engine ?? true
  const players = opts.linuxPlayers ?? ['pw-play']
  const ok = (r: RunResult = {}) => ({
    value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  // 書いた時刻はテストの時計（mock.clock）で残す。clock.advance で連発抑制などを確かめられる
  const put = (path: string, text: string) => {
    files.set(key(path), text)
    mtimes.set(key(path), clock.now())
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
    const custom = opts.run?.(argv)
    if (custom) return ok(custom) as never
    // Windows では curl.exe / powershell.exe と書く。.exe を外して比べる
    const cmd = argv[0]!.replace(/\.exe$/i, '')
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
    // rm -f -- <paths> / cmd /d /c del /f /q <paths>
    if (cmd === 'rm' || (cmd === 'cmd' && argv[3] === 'del')) {
      for (const a of argv.slice(cmd === 'rm' ? 3 : 6)) files.delete(key(a))
      return ok() as never
    }
    // 再生（Windows は powershell、macOS は afplay、Linux は sh の再生スクリプト）。どれも argv の最後が wav
    if (cmd === 'powershell' || cmd === 'afplay' || cmd === 'sh') {
      w.played.push(key(argv[argv.length - 1]!))
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
  // エンジンの役（プラグインの hook が next(e) で呼ぶ先）
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('classic.PermissionRequest', async () => ({}) as never)
  on('classic.Notification', async () => ({}) as never)
  on('classic.TaskCompleted', async () => ({}) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async ($, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } } as never
  })
  on('model.complete', async ($, e) => {
    w.asks.push(e as unknown as Record<string, unknown>)
    return { value: { ...(opts.reply ?? { isAnswered: true, text: '要約しました。' }), usage: { input_tokens: 0, output_tokens: 0 } } } as never
  })
  return w
}
