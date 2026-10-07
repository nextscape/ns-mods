import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Settings, Snapshot } from '../types'
import {
  BAND_ROWS,
  MINUTE,
  RESOLVED,
  TIDY_HINT_MIN,
  ago,
  noticeKey,
  notices,
  pullBlocker,
  statusLine,
  tellText,
} from './judge'
import {
  BRANCH_FORMAT,
  DEFAULTS,
  MARKERS,
  MIN_GIT,
  absolutePath,
  files,
  firstLine,
  isAuthError,
  isSupported,
  lines,
  parseBranches,
  parseConfig,
  parseRemoteHeads,
  parseStash,
  parseStatus,
  parseVersion,
  prunableWorktrees,
} from './parse'
import { deletedReport, describeTidy, planTidy, tidyCandidates, withGoneUpstream } from './tidy'

// Keeps an eye on the session's git repository: how far it is from its
// upstream, what was left behind (uncommitted changes, stashes, a half-done
// rebase, a stale index.lock) and which branches lost their upstream. It says
// so under the prompt and in a band above it, tells Claude when that changes,
// and changes the repository only three ways: fetch (never pruning), a
// fast-forward the person asks for, and `git branch -d` of merged branches
// after asking. It calls no model.

const snapshotState = atom({ plugin: 'git-nudge', key: 'snapshot' } as const, null)
const startState = atom({ plugin: 'git-nudge', key: 'start' } as const, null)
const dismissedState = atom({ plugin: 'git-nudge', key: 'dismissed' } as const, [])
const busyState = atom({ plugin: 'git-nudge', key: 'busy' } as const, false)

const LOCAL_TIMEOUT = 10_000
const REMOTE_TIMEOUT = 60_000
// git asks nothing on a terminal it does not have, nor through Git Credential
// Manager's window: a fetch that needs a login fails instead.
const REMOTE_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
const STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch']

// What a refresh fetches for: the session's first look, the timer, or a
// command that asks for it now.
type FetchWhen = 'start' | 'timer' | 'force' | false

type Ctx = {
  off: boolean
  interactive: boolean
  // undefined until checked; null when git could not be run.
  version: readonly [number, number] | null | undefined
  root: string | null
  // Why the mod is doing nothing, for /git-nudge; null while it works.
  reason: string | null
  settings: Settings
  problems: string[]
  // Refreshes run one after another on this chain, so none is dropped.
  queue: Promise<void>
  // Set while a pull runs, so a second press does not merge again.
  pulling: boolean
  timer: Timer | null
  interval: number
  authStopped: boolean
  failed: { at: number; auth: boolean } | null
  // What Claude was last told; null when nothing.
  told: string | null
  tidyHint: boolean
  // git status timeouts in a row; /git-nudge suggests turning the mod off.
  slow: number
}

type Run = { code: number; out: string; err: string }

const fetchKey = (root: string) => `fetch:${root}`
const hintKey = (root: string) => `tidy-hint:${root}`

export const register: Register = on => {
  const ctx: Ctx = {
    off: false,
    interactive: true,
    version: undefined,
    root: null,
    reason: null,
    settings: { ...DEFAULTS },
    problems: [],
    queue: Promise.resolve(),
    pulling: false,
    timer: null,
    interval: 0,
    authStopped: false,
    failed: null,
    told: null,
    tidyHint: false,
    slow: 0,
  }

  on('session.start', async ($, e, next) => {
    ctx.interactive = e.isInteractive
    // The first look (and fetch) runs once the session is up, not before it.
    $.clock.after(0, () => refresh($, ctx, 'start'))
    await $.command.register({
      name: 'git-nudge',
      description: 'git の遅れ・置き忘れを知らせる。pull で取り込み、tidy で片付け、off / on で停止と再開',
      argumentHint: '[pull|tidy|on|off]',
      immediate: true,
    })
    return next(e)
  })

  // /clear, /resume and /branch reset $.state: look again, and tell Claude afresh.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    ctx.told = null
    $.clock.after(0, () => refresh($, ctx, false))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, busyState, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, busyState, () => false)
      // Claude may have committed or pushed: look again, without fetching.
      $.clock.after(0, () => refresh($, ctx, false))
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const text = await tell($, ctx)
    return next(text === null ? e : { ...e, context: [...(e.context ?? []), text] })
    // Telling only adds: if it throws, the prompt goes as typed.
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'git-nudge' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pull') return { text: await pull($, ctx) }
    if (arg === 'tidy') return { text: await tidy($, ctx) }
    if (arg === 'off') {
      ctx.off = true
      await rest($, ctx)
      return { text: 'このセッションでは止めました（/git-nudge on で再開）' }
    }
    if (arg === 'on') ctx.off = false
    else if (arg !== '') return { text: `知らない引数です: ${arg}（pull / tidy / on / off。省略すると状態を表示）` }
    await refresh($, ctx, 'force')
    return { text: await report($, ctx) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    const snap = await read($, snapshotState)
    if (ctx.off || !ctx.settings.band || snap === null) return theirs
    const start = await read($, startState)
    const dismissed = await read($, dismissedState)
    const working = e.component === 'AbovePrompt' && e.props.isWorking
    const busy = (await read($, busyState)) || working
    const now = await $.clock.now()
    const shown = notices(snap, start, ctx.settings, now, ctx.tidyHint)
      .filter(notice => !dismissed.includes(noticeKey(notice)))
      .slice(0, BAND_ROWS)
    if (shown.length === 0) return theirs
    const { Box, Text, Button } = $.ui.resolve(e)
    // Letter hotkeys only: a digit on a band button fires from an empty
    // prompt, so a typed "1" could pull.
    const rows = shown.map((notice, index) =>
      Box({
        key: `row-${notice.id}`,
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({ children: [notice.text] }),
          ...(notice.pull && !busy
            ? [Button({ key: 'pull', label: '取り込む', hotkey: 'p', plain: true, onPress: () => pullFromBand($, ctx) })]
            : []),
          ...(index === 0
            ? [
                Button({
                  key: 'close',
                  label: '閉じる',
                  hotkey: 'x',
                  plain: true,
                  onPress: () => update($, dismissedState, list => [...list, ...shown.map(noticeKey)]),
                }),
              ]
            : []),
        ],
      }),
    )
    return Box({ flexDirection: 'column', children: [...rows, theirs] })
  })
}

// Runs git. A start failure or a timeout comes back as code -1, never as a throw.
async function git(
  $: EngineInterface,
  cwd: string,
  args: string[],
  options: { remote?: boolean; timeoutMs?: number } = {},
): Promise<Run> {
  try {
    const result = await $.process.run(['git', ...args], {
      cwd,
      timeoutMs: options.timeoutMs ?? (options.remote ? REMOTE_TIMEOUT : LOCAL_TIMEOUT),
      ...(options.remote ? { env: REMOTE_ENV } : {}),
    })
    return { code: result.exitCode, out: result.stdout, err: result.stderr }
  } catch (error) {
    return { code: -1, out: '', err: error instanceof Error ? error.message : String(error) }
  }
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

// Looks at the repository again, fetching when `when` asks for it, and
// redraws. A refresh asked for while another runs waits for it and then runs,
// so a pull's fetch or the look after a turn is never dropped. Never throws.
function refresh($: EngineInterface, ctx: Ctx, when: FetchWhen): Promise<void> {
  ctx.queue = ctx.queue.then(() => lookSafely($, ctx, when))
  return ctx.queue
}

async function lookSafely($: EngineInterface, ctx: Ctx, when: FetchWhen): Promise<void> {
  if (ctx.off) return
  try {
    await look($, ctx, when)
  } catch (error) {
    $.ui.log(`git-nudge: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

// Batch mode keeps ssh from asking for a host key or a passphrase, unless the
// person chose their own ssh command (GIT_SSH_COMMAND, GIT_SSH or core.sshCommand).
async function sshArgs($: EngineInterface, root: string): Promise<string[]> {
  if ((await $.env.get('GIT_SSH_COMMAND')) || (await $.env.get('GIT_SSH'))) return []
  const configured = await git($, root, ['config', '--get', 'core.sshCommand'])
  return configured.code === 0 ? [] : ['-c', 'core.sshCommand=ssh -o BatchMode=yes']
}

async function look($: EngineInterface, ctx: Ctx, when: FetchWhen): Promise<void> {
  const cwd = await $.session.cwd()
  if (ctx.version === undefined) {
    const version = await git($, cwd, ['version'])
    ctx.version = version.code === 0 ? parseVersion(version.out) : null
  }
  if (ctx.version === null) return idle($, ctx, 'git が見つかりません')
  if (!isSupported(ctx.version)) {
    return idle($, ctx, `git ${MIN_GIT.join('.')} 以降が必要です（今は ${ctx.version.join('.')}）`)
  }
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return idle($, ctx, 'git リポジトリの中ではありません')
  const root = top.out.trim()
  const config = await git($, root, ['config', '--get-regexp', '^git-nudge\\.'])
  const { settings, problems } = parseConfig(config.code === 0 ? config.out : '')
  ctx.settings = settings
  ctx.problems = problems
  if (!settings.enabled) {
    stopTimer(ctx)
    return idle($, ctx, 'git-nudge.enabled が false です')
  }
  if (root !== ctx.root) {
    ctx.root = root
    ctx.told = null
    ctx.authStopped = false
    ctx.failed = null
    ctx.tidyHint = false
    await update($, snapshotState, () => null)
    await update($, startState, () => null)
  }
  ctx.reason = null
  schedule($, ctx)

  const now = await $.clock.now()
  const prev = await read($, snapshotState)
  const branches = parseBranches((await git($, root, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'])).out)
  let status = await git($, root, STATUS_ARGS)
  if (status.code !== 0) {
    // Keep what is shown; a timeout counts toward suggesting enabled=false.
    if (status.code === -1) ctx.slow += 1
    $.ui.log(`git-nudge: git status failed: ${firstLine(status.err)}`, { to: 'debug' })
    return
  }
  ctx.slow = 0
  let parsed = parseStatus(status.out)
  const remote = branches.find(branch => branch.name === parsed.branch.head)?.remote ?? null
  let goneNames = prev?.goneNames ?? null
  let tidyCount = prev?.tidyCount ?? null

  if (when === 'force') ctx.authStopped = false
  const wants =
    when === 'force' ||
    (when === 'start' && settings.fetchOnStart) ||
    (when === 'timer' && settings.fetchInterval > 0)
  if (wants && remote !== null && !ctx.authStopped && (when === 'force' || (await fetchDue($, root, settings, now)))) {
    const ssh = await sshArgs($, root)
    const fetched = await git(
      $,
      root,
      ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20', ...ssh, 'fetch', '--quiet', '--no-auto-maintenance', remote],
      { remote: true },
    )
    if (fetched.code === 0) {
      ctx.failed = null
      await $.store.set(fetchKey(root), now)
      const listed = await git($, root, [...ssh, 'ls-remote', '--heads', remote], { remote: true })
      if (listed.code === 0) {
        const heads = parseRemoteHeads(listed.out)
        goneNames = withGoneUpstream(branches, heads, remote).map(branch => branch.name)
        tidyCount = tidyCandidates(branches, heads, remote).length
      }
      status = await git($, root, STATUS_ARGS)
      if (status.code === 0) parsed = parseStatus(status.out)
    } else {
      const auth = isAuthError(fetched.err)
      ctx.failed = { at: now, auth }
      if (auth) ctx.authStopped = true
      $.ui.log(`git-nudge: fetch failed: ${firstLine(fetched.err)}`, { to: 'debug' })
    }
  }

  const stash = parseStash((await git($, root, ['stash', 'list', '--format=%ct'])).out)
  const markers = await git($, root, [
    'rev-parse',
    ...MARKERS.flatMap(([name]) => ['--git-path', name]),
    '--git-path',
    'index.lock',
  ])
  const paths = markers.code === 0 ? lines(markers.out).map(path => absolutePath(root, path)) : []
  let operation: Snapshot['operation'] = null
  for (const [index, [, kind]] of MARKERS.entries()) {
    const path = paths[index]
    if (path !== undefined && (await exists($, path))) {
      operation = kind
      break
    }
  }
  const lockPath = paths[MARKERS.length]
  const locked = lockPath !== undefined && (await exists($, lockPath))
  const lastOk = await $.store.get(fetchKey(root))
  const snapshot: Snapshot = {
    root,
    status: parsed,
    stash,
    operation,
    lockSince: locked ? (prev?.lockSince ?? now) : null,
    goneNames,
    tidyCount,
    fetch: { lastOk: typeof lastOk === 'number' ? lastOk : null, failed: ctx.failed },
    at: now,
  }
  await update($, snapshotState, () => snapshot)
  if ((await read($, startState)) === null) {
    await update($, startState, () => ({ ahead: parsed.branch.ahead ?? 0, dirty: files(parsed.changes) }))
  }
  if (!ctx.tidyHint && tidyCount !== null && tidyCount >= TIDY_HINT_MIN) {
    const today = new Date(now).toISOString().slice(0, 10)
    if ((await $.store.get(hintKey(root))) !== today) {
      ctx.tidyHint = true
      await $.store.set(hintKey(root), today)
    }
  }
  $.ui.status(statusLine(snapshot, settings, now))
}

// Whether the repository's last fetch, by any session, is older than the interval.
async function fetchDue($: EngineInterface, root: string, settings: Settings, now: number): Promise<boolean> {
  const last = await $.store.get(fetchKey(root))
  if (typeof last !== 'number') return true
  return now - last >= Math.max(settings.fetchInterval, 1) * MINUTE - 10_000
}

// Keeps the fetch timer at the configured interval.
function schedule($: EngineInterface, ctx: Ctx) {
  const minutes = ctx.settings.fetchInterval
  if (ctx.timer !== null && ctx.interval === minutes) return
  stopTimer(ctx)
  ctx.interval = minutes
  if (minutes > 0) ctx.timer = $.clock.every(minutes * MINUTE, () => refresh($, ctx, 'timer'))
}

function stopTimer(ctx: Ctx) {
  ctx.timer?.cancel()
  ctx.timer = null
  ctx.interval = 0
}

// Nothing to look at: keep the reason for /git-nudge and clear what is shown.
async function idle($: EngineInterface, ctx: Ctx, reason: string): Promise<void> {
  ctx.reason = reason
  ctx.root = null
  await update($, snapshotState, () => null)
  $.ui.status(undefined)
}

// /git-nudge off: stop the timer and clear what is shown.
async function rest($: EngineInterface, ctx: Ctx): Promise<void> {
  stopTimer(ctx)
  await update($, snapshotState, () => null)
  $.ui.status(undefined)
}

// The context to add to this prompt: the state when it differs from what
// Claude was last told, a word that it cleared up, or null.
async function tell($: EngineInterface, ctx: Ctx): Promise<string | null> {
  if (ctx.off || !ctx.settings.tellClaude) return null
  const snap = await read($, snapshotState)
  if (snap === null) return null
  const text = tellText(notices(snap, await read($, startState), ctx.settings, await $.clock.now(), false))
  if (text === ctx.told) return null
  const said = text ?? (ctx.told !== null ? RESOLVED : null)
  ctx.told = text
  return said
}

// Fast-forwards to the upstream when that is safe now, and says what happened.
async function pull($: EngineInterface, ctx: Ctx): Promise<string> {
  if (ctx.off) return 'git-nudge は止まっています（/git-nudge on で再開）'
  if (ctx.pulling) return '取り込みの途中です。終わるまでお待ちください'
  ctx.pulling = true
  try {
    return await fastForward($, ctx)
  } finally {
    ctx.pulling = false
  }
}

const BUSY = 'Claude の作業中は取り込めません。作業が終わってから実行してください'

async function fastForward($: EngineInterface, ctx: Ctx): Promise<string> {
  if (await read($, busyState)) return BUSY
  // Fetch first, as git pull does: the last look may have skipped its fetch.
  await refresh($, ctx, 'force')
  const snap = await read($, snapshotState)
  if (snap === null) return ctx.reason ?? '状態を取得できませんでした'
  const blocker = pullBlocker(snap)
  if (blocker !== null) return `取り込みませんでした: ${blocker}`
  const before = (await git($, snap.root, ['rev-parse', '--short', 'HEAD'])).out.trim()
  // The fetch can take a while: a turn may have started meanwhile.
  if (await read($, busyState)) return BUSY
  const merged = await git($, snap.root, ['merge', '--ff-only', '@{u}'], { timeoutMs: REMOTE_TIMEOUT })
  const after = (await git($, snap.root, ['rev-parse', '--short', 'HEAD'])).out.trim()
  await refresh($, ctx, false)
  if (merged.code !== 0) return `取り込めませんでした: ${firstLine(merged.err || merged.out)}`
  return `取り込みました ${before} → ${after}（戻すには git reset --keep ${before}）`
}

async function pullFromBand($: EngineInterface, ctx: Ctx): Promise<void> {
  const message = await pull($, ctx)
  $.ui.toast(message, { timeoutMs: 8000 })
  $.ui.log(`git-nudge: ${message}`)
}

// Lists branches whose upstream is gone, asks, and deletes the merged ones.
async function tidy($: EngineInterface, ctx: Ctx): Promise<string> {
  if (!ctx.interactive) return '対話できない環境では片付けできません'
  const cwd = await $.session.cwd()
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return 'git リポジトリの中ではありません'
  const root = top.out.trim()
  const branches = parseBranches((await git($, root, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'])).out)
  const head = (await git($, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).out.trim()
  const remote = branches.find(branch => branch.name === head)?.remote ?? 'origin'
  const listed = await git($, root, [...(await sshArgs($, root)), 'ls-remote', '--heads', remote], { remote: true })
  if (listed.code !== 0) return `${remote} のブランチ一覧を取得できませんでした: ${firstLine(listed.err)}`
  const merged = new Set(lines((await git($, root, ['for-each-ref', '--merged', 'HEAD', '--format=%(refname:short)', 'refs/heads'])).out))
  const plan = planTidy(tidyCandidates(branches, parseRemoteHeads(listed.out), remote), merged)
  const prunable = prunableWorktrees((await git($, root, ['worktree', 'list', '--porcelain'])).out)
  const defaultRef = await git($, root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  const onDefault = defaultRef.code === 0 && head !== '' ? defaultRef.out.trim() === `${remote}/${head}` : null
  const summary = describeTidy(plan, prunable, onDefault)
  if (plan.deletable.length === 0) return summary

  const yes = `消せるブランチをすべて消す（${plan.deletable.length} 本）`
  let answer: string
  try {
    answer = await $.ui.ask(`upstream が消えたブランチのうち、${plan.deletable.length} 本を消せます。消しますか？`, {
      header: '片付け',
      options: [yes, 'やめる'],
    })
  } catch {
    return `${summary}\n\n片付けを取りやめました（確認できませんでした）`
  }
  if (answer !== yes) return `${summary}\n\n片付けを取りやめました`
  const done: typeof plan.deletable = []
  const failed: Array<{ name: string; message: string }> = []
  for (const branch of plan.deletable) {
    const deleted = await git($, root, ['branch', '-d', branch.name])
    if (deleted.code === 0) done.push(branch)
    else failed.push({ name: branch.name, message: firstLine(deleted.err) })
  }
  await refresh($, ctx, false)
  return `${summary}\n\n${deletedReport(done, failed)}`
}

// What /git-nudge prints.
async function report($: EngineInterface, ctx: Ctx): Promise<string> {
  if (ctx.off) return 'このセッションでは止めています（/git-nudge on で再開）'
  if (ctx.reason !== null) return `何もしていません: ${ctx.reason}`
  const slow =
    ctx.slow >= 2 ? ['git status が時間切れになっています。重いリポジトリでは git config git-nudge.enabled false で止められます'] : []
  const snap = await read($, snapshotState)
  if (snap === null) return ['状態をまだ取得していません', ...slow].join('\n')
  const now = await $.clock.now()
  const list = notices(snap, await read($, startState), ctx.settings, now, true)
  const out = [`リポジトリ: ${snap.root}`, `状態: ${statusLine(snap, ctx.settings, now) ?? '問題なし'}`]
  if (list.length > 0) out.push('お知らせ:', ...list.map(notice => `  ${notice.text}`))
  const when = [ctx.settings.fetchOnStart ? '開始時' : '', ctx.settings.fetchInterval > 0 ? `${ctx.settings.fetchInterval}分ごと` : '']
    .filter(Boolean)
    .join('と')
  const last = snap.fetch.lastOk === null ? 'まだ成功していません' : `最後の成功: ${ago(now - snap.fetch.lastOk)}`
  out.push(`fetch: ${when === '' ? 'オフ' : when}（${last}）${ctx.authStopped ? '（認証の失敗で止めています）' : ''}`)
  if (ctx.problems.length > 0) out.push('設定の問題:', ...ctx.problems.map(problem => `  ${problem}`))
  out.push(...slow)
  return out.join('\n')
}
