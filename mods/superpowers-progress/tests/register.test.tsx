import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'superpowers-progress',
  component: 'Pane',
  requestId: 'superpowers-progress',
  props: {
    title: 'Superpowers 進捗',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

type On = Parameters<TestBody>[1]

test('進捗と現在のタスクを表示し、クリックで一覧を開閉する', async ($, on) => {
  let created = 0
  on('command.register', () => ({ value: { command: 'superpowers-progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => {
    created += 1
    const subject = e.tool === 'TaskCreate' ? e.subject : ''
    return { result: { task: { id: String(created), subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({
    result: {
      success: true,
      taskId: e.tool === 'TaskUpdate' ? e.taskId : '',
      updatedFields: ['status'],
    },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const subject of ['設計を読む', 'APIを書く', 'テスト']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /完了/ }))?.text).toBe('完了 1　/　残り 2')
  expect(await ui.find({ type: 'Text', text: /3\. テスト/ })).toBeUndefined()

  await ui.press({ key: 'tasks' })
  expect((await ui.find({ type: 'Text', text: /3\. テスト/ }))?.text).toBe('・ 3. テスト')
  expect((await ui.find({ type: 'Text', text: /2\. APIを書く/ }))?.text).toBe('▶ 2. APIを書く')

  await ui.press({ key: 'tasks' })
  expect(await ui.find({ type: 'Text', text: /3\. テスト/ })).toBeUndefined()
  await ui.unmount()
})

test('サブエージェントのタスクは数えない', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: 'TaskCreate' }, () => ({
    result: { task: { id: '1', subject: 'x' } },
  }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'x', description: 'x', agentId: 'a1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('タスクはまだありません。')
  await ui.unmount()
})

const PLAN = [
  '# 検索画面の絞り込み Implementation Plan',
  '### Task 1: 条件の定義',
  '### Task 2: 絞り込みの処理',
  '### Task 3: 並べ替え',
].join('\n')
const DIR = '.superpowers/sdd/plan-a'
const LEDGER =
  '# SDD ledger — plan: docs/plans/plan-a.md\nTask 1: complete (commits a..b, review clean)\n'

// An SDD workspace as Superpowers lays it, answered from memory.
const sddFiles = (ledger: string, briefs: string[]): Record<string, string> => ({
  [`${DIR}/plan-path`]: 'docs/plans/plan-a.md\n',
  [`${DIR}/progress.md`]: ledger,
  'docs/plans/plan-a.md': PLAN,
  ...Object.fromEntries(briefs.map(n => [`${DIR}/task-${n}-brief.md`, ''])),
})

// Answers the session's files from `files`, as the engine resolves paths,
// and the tools an SDD controller calls.
const serveSdd = (on: On, files: Record<string, string>) => {
  const entry = (name: string, kind: 'file' | 'dir') => ({
    name,
    kind,
    size: 0,
    mtimeMs: 1000,
    isLink: false,
  })
  // The engine hands paths on resolved for the platform (`D:\repo\...`).
  const inRepo = (path: string) =>
    path.replace(/\\/g, '/').replace(/\/$/, '').replace(/^.*?\/repo\//, '')
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.list', (_, e) => {
    const path = inRepo(e.path)
    const names = Object.keys(files).filter(f => f.startsWith(`${DIR}/`))
    if (path === '.superpowers/sdd') {
      return { value: names.length > 0 ? [entry('plan-a', 'dir')] : [] }
    }
    if (path === DIR) {
      return { value: names.map(f => entry(f.slice(DIR.length + 1), 'file')) }
    }
    throw new Error(`no such dir: ${e.path}`)
  })
  on('fs.read', (_, e) => {
    const text = files[inRepo(e.path)]
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' } }))
  on('tool.call', { tool: 'Agent' }, () => ({ result: {} as never }))
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: {} as never }))
  on('tool.call', { tool: 'Skill' }, () => ({ result: {} as never }))
}

test('SDD の台帳と計画から進捗を表示する', async ($, on) => {
  serveSdd(on, sddFiles(LEDGER, ['1', '2']))
  await $.tool.call({ tool: 'Bash', command: 'echo' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /完了/ }))?.text).toBe('完了 1　/　残り 2')
  expect((await ui.find({ type: 'Text', text: /検索画面/ }))?.text).toBe('検索画面の絞り込み')
  await ui.press({ key: 'tasks' })
  expect((await ui.find({ type: 'Text', text: /1\. 条件/ }))?.text).toBe('✔ 1. 条件の定義')
  expect((await ui.find({ type: 'Text', text: /2\. 絞り込み/ }))?.text).toBe('▶ 2. 絞り込みの処理')
  expect((await ui.find({ type: 'Text', text: /3\. 並べ替え/ }))?.text).toBe('・ 3. 並べ替え')
  await ui.unmount()
})

test('今のタスクの段階を、実装からの流れで表示する', async ($, on) => {
  serveSdd(on, sddFiles(LEDGER, ['1', '2']))

  await $.tool.call({
    tool: 'Agent',
    description: 'Implement Task 2: filtering',
    prompt: 'You are implementing Task 2: 絞り込みの処理',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /実装/ }))?.text).toBe('  実装 …')
  await ui.unmount()

  await $.tool.call({
    tool: 'Agent',
    description: 'Review Task 2 (spec + quality)',
    prompt: "You are reviewing one task's implementation: first whether",
  })
  await $.tool.call({
    tool: 'SendMessage',
    to: 'a1',
    message: 'Task review found one Important issue (fix round 2). Please fix.',
  })
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await again.find({ type: 'Text', text: /実装/ }))?.text).toBe(
    '  実装 ✔ → レビュー ✔ → 修正 2/5 …',
  )
  await again.unmount()
})

test('台帳の判断・保留・後回しを数え、クリックで中身を開く', async ($, on) => {
  const ledger = [
    LEDGER.trim(),
    'Ruling: T2 also updates the page script — avoids a broken state',
    'Task 1: minor (deferred): could .ToArray() for nicer output',
    'Task 2: parked — naming nit — Ruling: the code stands',
  ].join('\n')
  serveSdd(on, sddFiles(ledger, ['1', '2']))
  await $.tool.call({ tool: 'Bash', command: 'echo' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'rulings' }))?.text).toMatch(/判断 1・保留 1・後回し 1/)
  expect(await ui.find({ type: 'Text', text: /\[保留\]/ })).toBeUndefined()

  await ui.press({ key: 'rulings' })
  expect((await ui.find({ type: 'Text', text: /\[保留\]/ }))?.text).toBe(
    '[保留] Task 2: parked — naming nit — Ruling: the code stands',
  )
  expect(await ui.find({ type: 'Text', text: /1\. 条件/ })).toBeUndefined()
  await ui.unmount()
})

test('呼ばれたスキルからワークフローの現在地を表示する', async ($, on) => {
  serveSdd(on, sddFiles(LEDGER, ['1', '2']))
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:writing-plans' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /\[計画\]/ }))?.text).toBe(
    '設計 ✔ › [計画] › 実装 › 仕上げ',
  )
  await ui.unmount()
})

test('SDD が作業フォルダを消しても、最後の進捗を表示し続ける', async ($, on) => {
  const files = sddFiles(LEDGER, ['1', '2'])
  serveSdd(on, files)
  await $.tool.call({ tool: 'Bash', command: 'echo' })
  for (const key of Object.keys(files)) {
    if (key.startsWith('.superpowers')) delete files[key]
  }
  await $.tool.call({ tool: 'Bash', command: 'rm' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /完了/ }))?.text).toBe('完了 1　/　残り 2')
  await ui.unmount()
})
