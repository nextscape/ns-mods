import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSION = 'sess-1'
const SESSION_PATH = `C:/Users/u/.claude/projects/p/${SESSION}/workflows/scripts/w.js`
const SAVED_PATH = 'C:/work/other/.claude/workflows/build.js'

const GOOD = "export const meta = { name: 'g', description: 'ok' }\nreturn await agent('p', { label: 'chore:scan', effort: 'low', model: 'sonnet' })"
const BAD = "export const meta = { name: 'b', description: 'whose agent() is below its floor' }\nreturn await agent('p', { label: 'review:diff', effort: 'medium' })"

// files: what $.fs.read answers by path; a path not listed throws. The
// engine hands the hook the path resolved for the OS (backslashes on
// Windows), so lookups compare with forward slashes.
function world(on: On, files: Record<string, string>, env?: Record<string, string>, store?: Record<string, unknown>) {
  mock.store(on, store)
  mock.clock(on)
  on('fs.write', async () => ({ value: undefined }))
  if (env) mock.env(on, env)
  const seen = { ran: 0, toasts: [] as string[] }
  const fileAt = (path: string) => files[path.replace(/\\/g, '/')]
  on('fs.read', async ($, e) => {
    const text = fileAt(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.exists', async ($, e) => ({ value: fileAt(e.path) !== undefined }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: 'C:/work/app' }))
  on('tool.call', async () => {
    seen.ran += 1
    return { result: {} } as never
  })
  on('prompt.compose', async () => ({ sections: [] }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

// A deny reaches the test as an errored result whose text is the reason.
const reasonOf = (r: unknown) => {
  const o = r as { deny?: string; text?: string }
  return o.deny ?? o.text ?? ''
}

describe('B: Workflow gate', () => {
  test('an inline script that breaks a rule is sent back in Japanese', async ($, on) => {
    const seen = world(on, {})
    const r = await $.tool.call({ tool: 'Workflow', script: BAD })
    expect(reasonOf(r)).toContain('quality-router: Workflow を差し戻しました（1件）。')
    expect(reasonOf(r)).toContain('review の下限は 上位・high です（現在 上位・medium）')
    expect(seen.ran).toBe(0)
    expect(seen.toasts).toContain('Workflow を差し戻しました（1件）')
  })

  test('a script that follows the rules runs', async ($, on) => {
    const seen = world(on, {})
    await $.tool.call({ tool: 'Workflow', script: GOOD })
    expect(seen.ran).toBe(1)
  })

  test('a session script on disk is checked, a resumed one included', async ($, on) => {
    const seen = world(on, { [SESSION_PATH]: BAD })
    const r = await $.tool.call({ tool: 'Workflow', scriptPath: SESSION_PATH, resumeFromRunId: 'wf_abcdef12' })
    expect(reasonOf(r)).toContain('差し戻しました')
    expect(seen.ran).toBe(0)
  })

  test('a saved script that breaks a rule is only warned about', async ($, on) => {
    const seen = world(on, { [SAVED_PATH]: BAD })
    await $.tool.call({ tool: 'Workflow', scriptPath: SAVED_PATH })
    expect(seen.ran).toBe(1)
    expect(seen.toasts).toContain('保存済みの Workflow に規則違反が 1 件あります（そのまま通しました）')
  })

  test('an unreadable script runs unchecked, with a toast', async ($, on) => {
    const seen = world(on, {})
    await $.tool.call({ tool: 'Workflow', scriptPath: SESSION_PATH })
    expect(seen.ran).toBe(1)
    expect(seen.toasts).toContain('Workflow を点検できなかったため、そのまま通しました')
  })

  test('a built-in named workflow that cannot be found runs without a toast', async ($, on) => {
    const seen = world(on, {})
    await $.tool.call({ tool: 'Workflow', name: 'review-changes' })
    expect(seen.ran).toBe(1)
    expect(seen.toasts).toEqual([])
  })

  test('a saved workflow called by name is read from .claude/workflows and only warned about', async ($, on) => {
    const seen = world(on, { 'C:/work/app/.claude/workflows/build.js': BAD })
    await $.tool.call({ tool: 'Workflow', name: 'build' })
    expect(seen.ran).toBe(1)
    expect(seen.toasts).toEqual(['保存済みの Workflow に規則違反が 1 件あります（そのまま通しました）'])
  })

  test('a name not in the project is looked up in the home folder, .mjs included', async ($, on) => {
    const seen = world(on, { 'C:/Users/u/.claude/workflows/x.mjs': BAD }, { USERPROFILE: 'C:\\Users\\u' })
    await $.tool.call({ tool: 'Workflow', name: 'x' })
    expect(seen.ran).toBe(1)
    expect(seen.toasts).toEqual(['保存済みの Workflow に規則違反が 1 件あります（そのまま通しました）'])
  })

  // A drive letter, because the engine resolves a path for the OS it runs on.
  test('HOME stands in when USERPROFILE is unset', async ($, on) => {
    const seen = world(on, { 'D:/home/u/.claude/workflows/x.js': BAD }, { HOME: 'D:/home/u' })
    await $.tool.call({ tool: 'Workflow', name: 'x' })
    expect(seen.toasts).toEqual(['保存済みの Workflow に規則違反が 1 件あります（そのまま通しました）'])
  })

  test('scriptPath is what runs, so it is what is checked, over script', async ($, on) => {
    const seen = world(on, { [SESSION_PATH]: GOOD })
    await $.tool.call({ tool: 'Workflow', scriptPath: SESSION_PATH, script: BAD } as never)
    expect(seen.ran).toBe(1)
    const r = await $.tool.call({ tool: 'Workflow', scriptPath: SESSION_PATH.replace('w.js', 'missing.js'), script: GOOD } as never)
    expect(seen.ran).toBe(2)
    expect(reasonOf(r)).toBe('')
    expect(seen.toasts).toEqual(['Workflow を点検できなかったため、そのまま通しました'])
  })

  test('gate off lets a bad script run', async ($, on) => {
    const seen = world(on, {})
    await $.command.run({ command: 'qr', args: 'gate off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await $.tool.call({ tool: 'Workflow', script: BAD })
    expect(seen.ran).toBe(1)
  })
})

describe('C: Workflow guidance', () => {
  // A render of the main loop's prompt, which offers the Workflow tool.
  const compose = (traits: string[] = [], tools: string[] = ['Bash', 'Workflow']) =>
    ({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools, outputStyle: null, traits }) as never
  const run = ($: Engine, args: string) =>
    $.command.run({ command: 'qr', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const guidance = async ($: Engine, traits?: string[], tools?: string[]) =>
    (await $.prompt.compose(compose(traits, tools))).sections.find(s => s.id === 'quality-router:guidance')

  test('the guidance section is added while the gate is on and dropped when off', async ($, on) => {
    world(on, {})
    const section = await guidance($)
    expect(section?.scope).toBe('session')
    expect(section?.text).toContain("{ model: 'opus', effort: 'max' }")
    await run($, 'gate off')
    expect(await guidance($)).toBe(undefined)
    await run($, 'gate on')
    expect(await guidance($)).toBeDefined()
  })

  test('the section follows /qr top', async ($, on) => {
    world(on, {})
    await run($, 'top fable')
    expect((await guidance($))?.text).toContain("{ model: 'claude-fable-5-1', effort: 'max' }")
  })

  test('hooks that come while the stored settings load wait for them, not the defaults', async ($, on) => {
    const seen = world(on, {}, undefined, { gate: 'off' })
    const [composed] = await Promise.all([
      $.prompt.compose(compose()),
      $.tool.call({ tool: 'Workflow', script: BAD }),
      $.tool.call({ tool: 'Workflow', script: BAD }),
    ])
    expect(composed.sections.map(s => s.id)).toEqual([])
    expect(seen.ran).toBe(2)
  })

  test('a --bare session, which asked for a one-line prompt, gets no section', async ($, on) => {
    world(on, {})
    expect(await guidance($, ['bare'])).toBe(undefined)
  })

  test('a render that does not offer the Workflow tool (a subagent, a Workflow agent) gets no section', async ($, on) => {
    world(on, {})
    expect(await guidance($, [], ['Bash', 'Read'])).toBe(undefined)
    expect(await guidance($, [], [])).toBe(undefined)
    expect(await guidance($, [], ['Workflow'])).toBeDefined()
  })
})
