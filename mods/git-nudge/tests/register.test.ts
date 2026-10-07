import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { RESOLVED } from '../hooks/judge'
import { FIXTURES } from './fixtures'

const NOW = Date.UTC(2026, 9, 7, 12)
const MINUTE = 60_000
const ROOT = 'D:/work/repo'
const FETCH = '-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch --quiet --no-auto-maintenance origin'

type Reply = { code?: number; out?: string; err?: string; deny?: string }
type Replies = Record<string, Reply | Reply[]>

const GIT_PATHS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'index.lock']

// A repository on main, in sync with origin/main, nothing left behind. A key
// matches the first git command line (without "git") that contains it; an
// array answers in turn and repeats its last entry.
const CLEAN: Replies = {
  version: { out: 'git version 2.49.0.windows.1\n' },
  'rev-parse --show-toplevel': { out: `${ROOT}\n` },
  'config --get-regexp': { code: 1 },
  'for-each-ref --format=': { out: `main\tb7bfd6b\torigin\trefs/heads/main\t${ROOT}\n` },
  'status --porcelain=v2': { out: FIXTURES['status-insync'] },
  'fetch --quiet': {},
  'ls-remote --heads': { out: 'b7bfd6b\trefs/heads/main\n' },
  'stash list': {},
  'rev-parse --git-path': { out: GIT_PATHS.map(name => `.git/${name}`).join('\n') + '\n' },
}

function world(
  on: On,
  overrides: Replies = {},
  options: { answer?: string; store?: Record<string, unknown>; files?: string[] } = {},
) {
  mock.store(on, options.store)
  const clock = mock.clock(on, { now: NOW })
  // Arrays are answered by shift(): copy them, so a shared constant such as
  // BEHIND answers every test from its start.
  const replies: Replies = Object.fromEntries(
    Object.entries({ ...CLEAN, ...overrides }).map(([key, reply]) => [key, Array.isArray(reply) ? [...reply] : reply]),
  )
  const seen = {
    git: [] as string[],
    env: [] as Array<Readonly<Record<string, string>> | undefined>,
    status: [] as Array<string | undefined>,
    toasts: [] as string[],
    context: [] as Array<readonly string[] | undefined>,
    asked: [] as string[],
  }
  const files = new Set(options.files ?? [])
  on('session.cwd', async () => ({ value: ROOT }))
  on('process.run', async ($, e) => {
    const line = e.argv.slice(1).join(' ')
    seen.git.push(line)
    seen.env.push(e.init?.env)
    const key = Object.keys(replies).find(one => line.includes(one))
    const entry = key === undefined ? { code: 1, err: `unstubbed: ${line}` } : replies[key]!
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry
    if (reply.deny !== undefined) return { deny: reply.deny }
    return {
      value: { exitCode: reply.code ?? 0, stdout: reply.out ?? '', stderr: reply.err ?? '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('fs.exists', async ($, e) => ({ value: files.has(e.path.replace(/\\/g, '/')) }))
  on('ui.status', async ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  // What other mods draw in the band beneath this one: nothing.
  on('ui.render', async () => ({ type: 'Box' as const }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('prompt.submit', async ($, e) => {
    seen.context.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('tool.call', async ($, e) => {
    const { questions } = e as unknown as { questions: Array<{ question: string }> }
    seen.asked.push(questions[0]!.question)
    if (options.answer === undefined) return { deny: 'dismissed' }
    return { result: { answers: { [questions[0]!.question]: options.answer } } }
  })
  return { seen, clock }
}

// Lets timer callbacks (and the git calls they make) finish.
async function settle(clock: MockClock) {
  for (let i = 0; i < 5; i++) await clock.settle()
}

async function begin($: Engine, clock: MockClock, isInteractive = true) {
  await $.session.start({ surface: 'terminal', isInteractive, cwd: ROOT })
  await settle(clock)
}

async function pass(clock: MockClock, ms: number) {
  await clock.advance(ms)
  await settle(clock)
}

const run = ($: Engine, args = '') =>
  $.command.run({
    command: 'git-nudge',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

// The person sending a prompt.
const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

let turns = 0
async function turn($: Engine, clock: MockClock) {
  const turnId = `t${++turns}`
  await $.turn.start({ text: 'x', turnId })
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await settle(clock)
}

const fetches = (git: string[]) => git.filter(line => line === FETCH).length

describe('looking at the repository', () => {
  test('the first look fetches once the session is up, and says nothing when all is in sync', async ($, on) => {
    const { seen, clock } = world(on)
    await begin($, clock)
    expect(fetches(seen.git)).toBe(1)
    expect(seen.status.at(-1)).toBeUndefined()
  })

  test('fetch never prunes, skips maintenance and asks for no login; status takes no lock', async ($, on) => {
    const { seen, clock } = world(on)
    await begin($, clock)
    const index = seen.git.indexOf(FETCH)
    expect(seen.env[index]).toEqual({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
    expect(seen.git.some(line => line.includes('--prune'))).toBe(false)
    expect(seen.git.filter(line => line.includes('status')).every(line => line.startsWith('--no-optional-locks status'))).toBe(true)
    expect(seen.env[seen.git.indexOf('version')]).toBeUndefined()
  })

  test('behind after the fetch shows in the status line', async ($, on) => {
    const { seen, clock } = world(on, {
      'status --porcelain=v2': [{ out: FIXTURES['status-insync'] }, { out: FIXTURES['status-behind'] }],
    })
    await begin($, clock)
    expect(seen.status.at(-1)).toBe('main ↓2 · fetch たった今')
  })

  test('the timer fetches every fetchInterval minutes', async ($, on) => {
    const { seen, clock } = world(on)
    await begin($, clock)
    await pass(clock, 5 * MINUTE)
    expect(fetches(seen.git)).toBe(2)
  })

  test('fetchOnStart false and fetchInterval 0 fetch nothing', async ($, on) => {
    const { seen, clock } = world(on, {
      'config --get-regexp': { out: 'git-nudge.fetchonstart false\ngit-nudge.fetchinterval 0\n' },
    })
    await begin($, clock)
    await pass(clock, 30 * MINUTE)
    expect(fetches(seen.git)).toBe(0)
  })

  test('a fetch another session made a minute ago is not repeated', async ($, on) => {
    const { seen, clock } = world(on, {}, { store: { [`fetch:${ROOT}`]: NOW - MINUTE } })
    await begin($, clock)
    expect(fetches(seen.git)).toBe(0)
  })

  test('an auth failure stops the timer fetch', async ($, on) => {
    const { seen, clock } = world(on, {
      'fetch --quiet': { code: 128, err: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" },
    })
    await begin($, clock)
    expect(seen.status.at(-1)).toBe('main · fetch 失敗')
    await pass(clock, 15 * MINUTE)
    expect(fetches(seen.git)).toBe(1)
  })

  test('a network failure tries again at the next interval', async ($, on) => {
    const { seen, clock } = world(on, {
      'fetch --quiet': { code: 128, err: "fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com\n" },
    })
    await begin($, clock)
    await pass(clock, 5 * MINUTE)
    expect(fetches(seen.git)).toBe(2)
  })

  test('a fetch that times out is a failure, not a crash', async ($, on) => {
    const { seen, clock } = world(on, { 'fetch --quiet': { deny: 'timed out' } })
    await begin($, clock)
    expect(seen.status.at(-1)).toBe('main · fetch 失敗')
  })

  test('outside a repository nothing shows, and /git-nudge says why', async ($, on) => {
    const { seen, clock } = world(on, { 'rev-parse --show-toplevel': { code: 128, err: 'fatal: not a git repository' } })
    await begin($, clock)
    expect(seen.status.at(-1)).toBeUndefined()
    expect((await run($)).text).toBe('何もしていません: git リポジトリの中ではありません')
  })

  test('git older than 2.29 does nothing', async ($, on) => {
    const { seen, clock } = world(on, { version: { out: 'git version 2.28.0\n' } })
    await begin($, clock)
    expect(fetches(seen.git)).toBe(0)
    expect((await run($)).text).toBe('何もしていません: git 2.29 以降が必要です（今は 2.28）')
  })

  test('enabled false does nothing', async ($, on) => {
    const { seen, clock } = world(on, { 'config --get-regexp': { out: 'git-nudge.enabled false\n' } })
    await begin($, clock)
    expect(fetches(seen.git)).toBe(0)
    expect((await run($)).text).toBe('何もしていません: git-nudge.enabled が false です')
  })

  test('a half-done merge is found by an absolute git path (a linked worktree)', async ($, on) => {
    const paths = GIT_PATHS.map(name => (name === 'MERGE_HEAD' ? 'C:/main/.git/worktrees/wt/MERGE_HEAD' : `.git/${name}`))
    const { seen, clock } = world(
      on,
      { 'rev-parse --git-path': { out: paths.join('\r\n') + '\r\n' } },
      { files: ['C:/main/.git/worktrees/wt/MERGE_HEAD'] },
    )
    await begin($, clock)
    expect(seen.status.at(-1)).toBe('main · merge 中 · fetch たった今')
  })

  test('index.lock is reported once it has stayed ten minutes', async ($, on) => {
    const { seen, clock } = world(on, {}, { files: [`${ROOT}/.git/index.lock`] })
    await begin($, clock)
    expect(seen.status.at(-1)).toBeUndefined()
    // One timer interval at a time, so each refresh finishes before the next.
    await pass(clock, 5 * MINUTE)
    expect(seen.status.at(-1)).toBeUndefined()
    await pass(clock, 5 * MINUTE)
    expect(seen.status.at(-1)).toBe('main · lock · fetch たった今')
  })

  test('the end of a turn looks again without fetching', async ($, on) => {
    const { seen, clock } = world(on, {
      'status --porcelain=v2': [
        { out: FIXTURES['status-insync'] },
        { out: FIXTURES['status-insync'] },
        { out: FIXTURES['status-dirty'] },
      ],
    })
    await begin($, clock)
    await turn($, clock)
    expect(seen.status.at(-1)).toBe('main · 未コミット 3 · fetch たった今')
    expect(fetches(seen.git)).toBe(1)
  })

  test('an upstream ls-remote no longer lists shows as gone', async ($, on) => {
    const { seen, clock } = world(on, {
      'for-each-ref --format=': { out: `feat-x\tabc\torigin\trefs/heads/feat-x\t${ROOT}\n` },
      'status --porcelain=v2': { out: '# branch.oid abc\n# branch.head feat-x\n# branch.upstream origin/feat-x\n# branch.ab +0 -0\n' },
    })
    await begin($, clock)
    expect(seen.status.at(-1)).toBe('feat-x upstream 消滅 · fetch たった今')
  })
})

const BAND = {
  plugin: 'git-nudge',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const band = ($: Engine, isWorking = false) =>
  $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking }, surface: 'terminal' })

const BEHIND = [{ out: FIXTURES['status-insync'] }, { out: FIXTURES['status-behind'] }]

describe('the band and pulling', () => {
  test('behind and clean: the band offers p to pull, and no button has a digit hotkey', async ($, on) => {
    const { clock } = world(on, { 'status --porcelain=v2': BEHIND })
    await begin($, clock)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: 'origin/main より 2 遅れ' })).toBeDefined()
    expect(await ui.find({ key: 'pull' })).toMatchObject({ type: 'Button', props: { hotkey: 'p' } })
    expect(await ui.find({ key: 'close' })).toMatchObject({ type: 'Button', props: { hotkey: 'x' } })
    for (const button of await ui.findAll({ type: 'Button' })) {
      expect((button as { props: { hotkey?: string } }).props.hotkey ?? '').not.toMatch(/^\d$/)
    }
    await ui.unmount()
  })

  test('p fast-forwards with merge --ff-only @{u} and says how to go back', async ($, on) => {
    const { seen, clock } = world(on, {
      // The first look, then pull's own look before and after its fetch, then after the merge.
      'status --porcelain=v2': [
        ...BEHIND,
        { out: FIXTURES['status-behind'] },
        { out: FIXTURES['status-behind'] },
        { out: FIXTURES['status-insync'] },
      ],
      'rev-parse --short HEAD': [{ out: 'c7f8761\n' }, { out: 'b7bfd6b\n' }],
      'merge --ff-only': {},
    })
    await begin($, clock)
    const ui = await band($)
    await ui.press({ key: 'pull' })
    await settle(clock)
    expect(seen.toasts).toEqual(['取り込みました c7f8761 → b7bfd6b（戻すには git reset --keep c7f8761）'])
    expect(seen.git).toContain('merge --ff-only @{u}')
    expect(seen.git.some(line => line.startsWith('pull'))).toBe(false)
    await ui.unmount()
  })

  test('with tracked changes the band says to pull by hand and offers no button', async ($, on) => {
    const dirty = `${FIXTURES['status-behind']}1 .M N... 100644 100644 100644 aaa aaa f.txt\n`
    const { clock } = world(on, { 'status --porcelain=v2': [{ out: FIXTURES['status-insync'] }, { out: dirty }] })
    await begin($, clock)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: 'origin/main より 2 遅れ。未コミットの変更があるので、取り込みは手動で' })).toBeDefined()
    expect(await ui.find({ key: 'pull' })).toBeUndefined()
    await ui.unmount()
  })

  test('no pull button while Claude works, and /git-nudge pull waits for the turn to end', async ($, on) => {
    const { clock } = world(on, { 'status --porcelain=v2': BEHIND })
    await begin($, clock)
    const working = await band($, true)
    expect(await working.find({ key: 'pull' })).toBeUndefined()
    await working.unmount()
    await $.turn.start({ text: 'x', turnId: 'busy-1' })
    expect((await run($, 'pull')).text).toBe('Claude の作業中は取り込めません。作業が終わってから実行してください')
  })

  test('/git-nudge pull says why it will not pull', async ($, on) => {
    const { seen, clock } = world(on, {
      'status --porcelain=v2': [{ out: FIXTURES['status-insync'] }, { out: FIXTURES['status-diverged'] }],
    })
    await begin($, clock)
    expect((await run($, 'pull')).text).toBe('取り込みませんでした: origin/main と分岐しています（↓2 ↑1）')
    expect(seen.git.some(line => line.startsWith('merge'))).toBe(false)
  })

  test('git refusing the fast-forward is passed on', async ($, on) => {
    const { clock } = world(on, {
      'status --porcelain=v2': BEHIND,
      'rev-parse --short HEAD': { out: 'c7f8761\n' },
      'merge --ff-only': { code: 128, err: 'fatal: Not possible to fast-forward, aborting.\n' },
    })
    await begin($, clock)
    expect((await run($, 'pull')).text).toBe('取り込めませんでした: fatal: Not possible to fast-forward, aborting.')
  })

  test('/git-nudge pull fetches first, so commits pushed since the last look are taken in', async ($, on) => {
    // Another session fetched a minute ago, so the first look skipped its fetch
    // and saw main in sync; the remote has moved on since.
    const { seen, clock } = world(
      on,
      {
        'status --porcelain=v2': [
          { out: FIXTURES['status-insync'] },
          { out: FIXTURES['status-insync'] },
          { out: FIXTURES['status-behind'] },
          { out: FIXTURES['status-insync'] },
        ],
        'rev-parse --short HEAD': [{ out: 'c7f8761\n' }, { out: 'b7bfd6b\n' }],
        'merge --ff-only': {},
      },
      { store: { [`fetch:${ROOT}`]: NOW - MINUTE } },
    )
    await begin($, clock)
    expect(fetches(seen.git)).toBe(0)
    expect((await run($, 'pull')).text).toBe('取り込みました c7f8761 → b7bfd6b（戻すには git reset --keep c7f8761）')
    expect(fetches(seen.git)).toBe(1)
  })

  test('pull outside a repository, before any look, answers instead of failing', async ($, on) => {
    world(on, { 'rev-parse --show-toplevel': { code: 128, err: 'fatal: not a git repository' } })
    expect((await run($, 'pull')).text).toBe('git リポジトリの中ではありません')
  })

  test('x hides the notices shown until they change', async ($, on) => {
    const behind3 = FIXTURES['status-behind'].replace('-2', '-3')
    const { clock } = world(on, {
      'status --porcelain=v2': [...BEHIND, { out: FIXTURES['status-behind'] }, { out: behind3 }],
    })
    await begin($, clock)
    const ui = await band($)
    await ui.press({ key: 'close' })
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: 'origin/main より 2 遅れ' })).toBeUndefined()
    await run($)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: 'origin/main より 3 遅れ' })).toBeDefined()
    await ui.unmount()
  })

  test('band false keeps the band empty', async ($, on) => {
    const { clock } = world(on, {
      'status --porcelain=v2': BEHIND,
      'config --get-regexp': { out: 'git-nudge.band false\n' },
    })
    await begin($, clock)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: 'origin/main より 2 遅れ' })).toBeUndefined()
    await ui.unmount()
  })

  test('an auth failure shows in the band', async ($, on) => {
    const { clock } = world(on, { 'fetch --quiet': { code: 128, err: 'git@github.com: Permission denied (publickey).\n' } })
    await begin($, clock)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: 'fetch が認証で失敗しました。このセッションでは定期 fetch を止めます' })).toBeDefined()
    await ui.unmount()
  })

  test('five branches with a gone upstream suggest tidy once a day', async ($, on) => {
    const gone = ['a', 'b', 'c', 'd', 'e'].map(name => `${name}\t111\torigin\trefs/heads/${name}\t`).join('\n')
    const replies = { 'for-each-ref --format=': { out: `main\tb7bfd6b\torigin\trefs/heads/main\t${ROOT}\n${gone}\n` } }
    const { clock } = world(on, replies)
    await begin($, clock)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: 'upstream が消えたブランチ 5 本 → /git-nudge tidy' })).toBeDefined()
    await ui.unmount()
  })

  test('the tidy hint stays quiet when another session showed it today', async ($, on) => {
    const gone = ['a', 'b', 'c', 'd', 'e'].map(name => `${name}\t111\torigin\trefs/heads/${name}\t`).join('\n')
    const replies = { 'for-each-ref --format=': { out: `main\tb7bfd6b\torigin\trefs/heads/main\t${ROOT}\n${gone}\n` } }
    const { clock } = world(on, replies, { store: { [`tidy-hint:${ROOT}`]: '2026-10-07' } })
    await begin($, clock)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: 'upstream が消えたブランチ 5 本 → /git-nudge tidy' })).toBeUndefined()
    await ui.unmount()
  })
})

const WARNING = 'これは情報です。ユーザーの指示なしに pull・rebase・push・ブランチの削除をしないでください。'

describe('telling Claude', () => {
  test('Claude hears of the state once, not again until it changes', async ($, on) => {
    const { seen, clock } = world(on, { 'status --porcelain=v2': BEHIND })
    await begin($, clock)
    await submit($, 'a')
    await submit($, 'b')
    expect(seen.context[0]).toEqual([`[git-nudge] このリポジトリの状態: origin/main より 2 遅れ\n${WARNING}`])
    expect(seen.context[1]).toBeUndefined()
  })

  test('once it clears up, Claude hears so once', async ($, on) => {
    const { seen, clock } = world(on, {
      'status --porcelain=v2': [...BEHIND, { out: FIXTURES['status-insync'] }],
    })
    await begin($, clock)
    await submit($, 'a')
    await turn($, clock)
    await submit($, 'b')
    await submit($, 'c')
    expect(seen.context[1]).toEqual([RESOLVED])
    expect(seen.context[2]).toBeUndefined()
  })

  test('all in sync adds nothing', async ($, on) => {
    const { seen, clock } = world(on)
    await begin($, clock)
    await submit($, 'a')
    expect(seen.context[0]).toBeUndefined()
  })

  test('tellClaude false tells nothing', async ($, on) => {
    const { seen, clock } = world(on, {
      'status --porcelain=v2': BEHIND,
      'config --get-regexp': { out: 'git-nudge.tellclaude false\n' },
    })
    await begin($, clock)
    await submit($, 'a')
    expect(seen.context[0]).toBeUndefined()
  })

  test('commits left unpushed before the session are told', async ($, on) => {
    const { seen, clock } = world(on, { 'status --porcelain=v2': { out: FIXTURES['status-ahead'] } })
    await begin($, clock)
    await submit($, 'a')
    expect(seen.context[0]).toEqual([`[git-nudge] このリポジトリの状態: 前回からの未 push 1 件\n${WARNING}`])
  })
})

// The fixture repository: feat-merged (merged) and feat-squash (squashed) lost
// their upstream; feat-wt too, but it is checked out in another worktree.
const TIDY: Replies = {
  'for-each-ref --format=': { out: FIXTURES['branches'] },
  'symbolic-ref --quiet --short HEAD': { out: 'main\n' },
  'ls-remote --heads': { out: FIXTURES['ls-remote'] },
  'for-each-ref --merged': { out: FIXTURES['merged'] },
  'worktree list': { out: FIXTURES['worktrees'] },
  'symbolic-ref --quiet --short refs/remotes': { out: 'origin/main\n' },
  'branch -d': {},
}

describe('tidy and the command', () => {
  test('tidy lists, asks, and deletes only the merged branch, with -d', async ($, on) => {
    const { seen, clock } = world(on, TIDY, { answer: '消せるブランチをすべて消す（1 本）' })
    await begin($, clock)
    const { text } = await run($, 'tidy')
    expect(seen.asked).toEqual(['upstream が消えたブランチのうち、1 本を消せます。消しますか？'])
    expect(seen.git).toContain('branch -d feat-merged')
    expect(seen.git.some(line => line.startsWith('branch -D'))).toBe(false)
    expect(seen.git.some(line => line.includes('feat-squash') && line.startsWith('branch'))).toBe(false)
    expect(text).toContain('git branch feat-merged feb4622258cea9cb375166f35dbd128e5144ec82')
    expect(text).toContain('git branch -D feat-squash')
    expect(text).toContain('git worktree prune')
  })

  test('choosing to stop deletes nothing', async ($, on) => {
    const { seen, clock } = world(on, TIDY, { answer: 'やめる' })
    await begin($, clock)
    expect((await run($, 'tidy')).text).toContain('片付けを取りやめました')
    expect(seen.git.some(line => line.startsWith('branch -d'))).toBe(false)
  })

  test('closing the question deletes nothing', async ($, on) => {
    const { seen, clock } = world(on, TIDY)
    await begin($, clock)
    expect((await run($, 'tidy')).text).toContain('片付けを取りやめました（確認できませんでした）')
    expect(seen.git.some(line => line.startsWith('branch -d'))).toBe(false)
  })

  test('a session without a person to ask does not tidy', async ($, on) => {
    const { seen, clock } = world(on, TIDY)
    await begin($, clock, false)
    expect((await run($, 'tidy')).text).toBe('対話できない環境では片付けできません')
    expect(seen.asked).toEqual([])
  })

  test('nothing to tidy says so without asking', async ($, on) => {
    const { seen, clock } = world(on, {
      ...TIDY,
      'ls-remote --heads': { out: FIXTURES['ls-remote'] + 'x\trefs/heads/feat-merged\nx\trefs/heads/feat-squash\nx\trefs/heads/feat-wt\n' },
      'worktree list': { out: `worktree ${ROOT}\nHEAD b7bfd6b\nbranch refs/heads/main\n` },
    })
    await begin($, clock)
    expect((await run($, 'tidy')).text).toBe('upstream が消えたブランチはありません。')
    expect(seen.asked).toEqual([])
  })

  test('off stops looking and fetching for the session; on starts again', async ($, on) => {
    const { seen, clock } = world(on)
    await begin($, clock)
    expect((await run($, 'off')).text).toBe('このセッションでは止めました（/git-nudge on で再開）')
    await pass(clock, 15 * MINUTE)
    expect(fetches(seen.git)).toBe(1)
    expect((await run($)).text).toBe('このセッションでは止めています（/git-nudge on で再開）')
    await run($, 'on')
    expect(fetches(seen.git)).toBe(2)
  })

  test('/git-nudge shows the state, the fetch schedule and settings it ignored', async ($, on) => {
    const { clock } = world(on, {
      'status --porcelain=v2': BEHIND,
      'config --get-regexp': { out: 'git-nudge.band maybe\ngit-nudge.fetchintervall 3\n' },
    })
    await begin($, clock)
    const { text } = await run($)
    expect(text).toContain(`リポジトリ: ${ROOT}`)
    expect(text).toContain('状態: main ↓2 · fetch たった今')
    expect(text).toContain('  origin/main より 2 遅れ')
    expect(text).toContain('fetch: 開始時と5分ごと')
    expect(text).toContain('  git-nudge.band=maybe は true / false ではないので無視しました')
    expect(text).toContain('  git-nudge.fetchintervall は知らない設定です')
  })

  test('an unknown argument is refused', async ($, on) => {
    world(on)
    expect((await run($, 'push')).text).toBe('知らない引数です: push（pull / tidy / on / off。省略すると状態を表示）')
  })

  test('git status timing out again and again suggests turning the mod off', async ($, on) => {
    const { clock } = world(on, { 'status --porcelain=v2': { deny: 'timed out' } })
    await begin($, clock)
    expect((await run($)).text).toBe(
      '状態をまだ取得していません\ngit status が時間切れになっています。重いリポジトリでは git config git-nudge.enabled false で止められます',
    )
  })
})
