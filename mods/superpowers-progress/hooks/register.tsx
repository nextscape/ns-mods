import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OpenList, Phase, Ruling, SddProgress, Stage, Task } from '../types'
import {
  agentStage,
  completedTasks,
  ledgerRulings,
  messageStage,
  planTasks,
  planTitle,
  skillPhase,
} from './parse'

const PANE = 'superpowers-progress'
const TITLE = 'Superpowers 進捗'
// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const tasks = atom({ plugin: 'superpowers-progress', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})
// When the Task tools last changed `tasks`, to weigh them against the ledger.
const tasksAt = atom({ plugin: 'superpowers-progress', key: 'tasksAt' } as const, 0)
const sdd = atom({ plugin: 'superpowers-progress', key: 'sdd' } as const, null, {
  shape: 'sdd-3',
})
const stage = atom({ plugin: 'superpowers-progress', key: 'stage' } as const, null, {
  shape: 'stage-1',
})
const phase = atom(
  { plugin: 'superpowers-progress', key: 'phase' } as const,
  null as Phase | null,
)
const openList = atom(
  { plugin: 'superpowers-progress', key: 'openList' } as const,
  'none' as OpenList,
)

// What TaskCreate and TaskUpdate answer, read loosely: `next(e)` is not typed
// per tool.
type Created = { task?: { id: string; subject: string } } | undefined
type Updated = { success?: boolean } | undefined

// Superpowers' subagent-driven development keeps no todos: each plan's
// workspace holds the plan's path and a ledger of completed tasks. Paths are
// the session's: a relative one would resolve against the mod's folder.
const SDD_ROOT = '.superpowers/sdd'

const readSdd = async ($: EngineInterface): Promise<SddProgress | null> => {
  const cwd = await $.session.cwd()
  const root = `${cwd}/${SDD_ROOT}`
  const dirs = (await $.fs.list(root)).filter(one => one.kind === 'dir')
  let newest: { dir: string; names: string[]; at: number } | null = null
  for (const { name } of dirs) {
    const dir = `${root}/${name}`
    const entries = await $.fs.list(dir).catch(() => [])
    const ledger = entries.find(one => one.name === 'progress.md')
    const hasPlan = entries.some(one => one.name === 'plan-path')
    if (!ledger || !hasPlan || (newest && newest.at >= ledger.mtimeMs)) continue
    newest = { dir, names: entries.map(one => one.name), at: ledger.mtimeMs }
  }
  if (!newest) return null

  // The marker is repo-relative for a plan in the repo, absolute otherwise.
  const planPath = (await $.fs.read(`${newest.dir}/plan-path`)).trim()
  const isAbsolute = /^([A-Za-z]:)?[\\/]/.test(planPath)
  const plan = await $.fs.read(isAbsolute ? planPath : `${cwd}/${planPath}`)
  const ledger = await $.fs.read(`${newest.dir}/progress.md`)
  const done = completedTasks(ledger)
  const headings = planTasks(plan)
  const firstOpen = headings.find(one => !done.has(one.n))?.n
  const isStarted = newest.names.includes(`task-${firstOpen}-brief.md`)

  return {
    at: newest.at,
    title: planTitle(plan),
    rulings: ledgerRulings(ledger),
    tasks: headings.map(({ n, subject }) => ({
      id: `sdd-${n}`,
      subject,
      status: done.has(n)
        ? 'completed'
        : n === firstOpen && isStarted
          ? 'in_progress'
          : 'pending',
    })),
  }
}

// The tool has already run: a failed redraw must not cost the agent its result.
const safely = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {}
}

const stamp = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await update($, tasksAt, () => now)
}

// Reads the ledger again; opens the pane when it moved on. SDD deletes its
// workspace once the branch is reviewed: the last progress read stays shown.
const refreshSdd = async ($: EngineInterface) => {
  const found = await readSdd($).catch(() => null)
  const known = await read($, sdd)
  if (!found || found.at === known?.at) return

  await update($, sdd, () => found)
  if (found.tasks.length > 0) void $.ui.open({ id: PANE, title: TITLE })
}

const MARK = { completed: '✔', in_progress: '▶', pending: '・' } as const
const PHASES: { phase: Phase; label: string }[] = [
  { phase: 'design', label: '設計' },
  { phase: 'plan', label: '計画' },
  { phase: 'build', label: '実装' },
  { phase: 'finish', label: '仕上げ' },
]
const RULING_LABEL = { ruling: '判断', parked: '保留', deferred: '後回し' } as const
const RULING_COLOR = {
  ruling: 'suggestion',
  parked: 'warning',
  deferred: 'subtle',
} as const

// The steps a task has passed through, the last one running.
const stageSteps = (one: Stage) => {
  if (one.task === null) {
    return one.step === 'final-fix'
      ? ['最終レビュー', `最終修正${one.round > 0 ? ` ${one.round}` : ''}`]
      : ['最終レビュー']
  }
  const steps = ['実装']
  if (one.step === 'implement') return steps
  steps.push('レビュー')
  if (one.step === 'review') return steps
  steps.push(`修正 ${Math.max(1, one.round)}/5`)
  if (one.step === 'fix') return steps
  steps.push('再レビュー')

  return steps
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'superpowers-progress',
      description: 'Superpowers 進捗のペインを開く',
    })

    const started = await next(e)
    await safely(() => refreshSdd($))

    return started
  })

  on('command.run', { command: 'superpowers-progress' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Superpowers 進捗のペインを開きました。' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId) await safely(() => refreshSdd($))

    return ran
  })

  // The step is the dispatch's, so it is written before the subagent runs.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!e.agentId && e.tool === 'Agent') {
      const { description, prompt } = e
      await safely(() =>
        update($, stage, before => agentStage(description, prompt, before) ?? before),
      )
    }

    return next(e)
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (!e.agentId && e.tool === 'SendMessage') {
      const { message } = e
      await safely(() =>
        update($, stage, before => messageStage(message, before) ?? before),
      )
    }

    return next(e)
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (!e.agentId && e.tool === 'Skill') {
      const found = skillPhase(e.skill)
      if (found) await safely(() => update($, phase, () => found))
    }

    return next(e)
  })

  // Only the main agent's tasks: a subagent's calls carry `agentId`.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const created = ran.isError ? undefined : (ran.result as Created)?.task
    if (e.agentId || !created) return ran

    const { id, subject } = created
    await safely(async () => {
      await update($, tasks, list => [
        ...list,
        { id, subject, status: 'pending' as const },
      ])
      await stamp($)
      void $.ui.open({ id: PANE, title: TITLE })
    })

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    const isUpdated = !ran.isError && (ran.result as Updated)?.success
    if (e.agentId || e.tool !== 'TaskUpdate' || !isUpdated) {
      return ran
    }

    const { taskId, status, subject } = e
    await safely(async () => {
      await update($, tasks, list =>
        status === 'deleted'
          ? list.filter(one => one.id !== taskId)
          : list.map(one =>
              one.id === taskId
                ? {
                    ...one,
                    subject: subject ?? one.subject,
                    status: status ?? one.status,
                  }
                : one,
            ),
      )
      await stamp($)
    })

    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || e.tool !== 'TodoWrite' || ran.isError) return ran

    const todos = e.todos
    await safely(async () => {
      await update($, tasks, () =>
        todos.map((todo, i) => ({
          id: `todo-${i + 1}`,
          subject: todo.content,
          status: todo.status,
        })),
      )
      await stamp($)
      if (todos.length > 0) void $.ui.open({ id: PANE, title: TITLE })
    })

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const fromTools = await read($, tasks)
    const fromSdd = await read($, sdd)
    const isSdd =
      !!fromSdd &&
      fromSdd.tasks.length > 0 &&
      fromSdd.at > (await read($, tasksAt))
    const list: Task[] = isSdd ? fromSdd.tasks : fromTools
    const title = isSdd ? fromSdd.title : ''
    const rulings: Ruling[] = isSdd ? fromSdd.rulings : []
    const current = isSdd ? await read($, stage) : null
    const nowPhase = await read($, phase)
    const open = await read($, openList)
    const columns = e.props?.bodyColumns ?? 40

    const toggle = (which: OpenList) => () =>
      update($, openList, was => (was === which ? 'none' : which))
    // A pressable row: the triangle, the accent and the underline under the
    // pointer tell it from the text around it; ▼ unfolds, ▲ folds.
    const pressable = (key: OpenList, label: string) => (
      <Box key={`row-${key}`}>
        <Button key={key} plain hover={{ underline: true }} onPress={toggle(key)}>
          <Text color="suggestion">{open === key ? '▲ ' : '▼ '}</Text>
          {label}
        </Button>
      </Box>
    )
    const rule = <Text dimColor>{'─'.repeat(Math.max(4, columns - 1))}</Text>

    const at = PHASES.findIndex(p => p.phase === nowPhase)
    const phaseRow = nowPhase && (
      <Text wrap="truncate-end">
        {PHASES.map(({ label }, i) => {
          const sep = i > 0 ? <Text dimColor> › </Text> : null
          if (i < at) {
            return (
              <Text>
                {sep}
                <Text color="success" dimColor>
                  {label} ✔
                </Text>
              </Text>
            )
          }
          if (i === at) {
            return (
              <Text>
                {sep}
                <Text color="suggestion" bold>
                  [{label}]
                </Text>
              </Text>
            )
          }

          return (
            <Text dimColor>
              {sep}
              {label}
            </Text>
          )
        })}
      </Text>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {phaseRow}
          <Text dimColor>タスクはまだありません。</Text>
        </Box>
      )
    }

    const total = list.length
    const done = list.filter(one => one.status === 'completed').length
    const left = total - done
    const currentIndex = list.findIndex(one => one.status === 'in_progress')
    const nextIndex = list.findIndex(one => one.status !== 'completed')
    const shownIndex = currentIndex >= 0 ? currentIndex : nextIndex
    const shown = list[shownIndex]
    const isAllDone = left === 0
    const numberOf = (one: Task | undefined, i: number) =>
      one?.id.startsWith('sdd-') ? one.id.slice(4) : String(i + 1)

    const count = `${done}/${total}`
    const barWidth = Math.max(4, Math.min(30, columns - count.length - 2))
    const filled = Math.round((done / total) * barWidth)
    const bar = '█'.repeat(filled)
    const rest = '░'.repeat(barWidth - filled)

    const taskLabel = isAllDone
      ? 'すべて完了'
      : `Task${numberOf(shown, shownIndex)}: ${shown?.subject ?? ''}`
    const stageFor =
      current &&
      (isAllDone
        ? current.task === null
        : String(current.task) === numberOf(shown, shownIndex))
        ? stageSteps(current)
        : null

    const counts = (['ruling', 'parked', 'deferred'] as const)
      .map(kind => ({ kind, n: rulings.filter(one => one.kind === kind).length }))
      .filter(({ n }) => n > 0)

    return (
      <Box flexDirection="column">
        {title !== '' && (
          <Text bold size="title" wrap="truncate-end">
            {title}
          </Text>
        )}
        {phaseRow}
        {(phaseRow || title !== '') && rule}

        {!isAllDone && (
          <Text dimColor>{currentIndex >= 0 ? '実行中' : '次のタスク'}</Text>
        )}
        {pressable('tasks', taskLabel)}
        {stageFor && (
          <Text wrap="truncate-end">
            {'  '}
            {stageFor.map((step, i) => {
              const sep = i > 0 ? <Text dimColor> → </Text> : null

              return i === stageFor.length - 1 ? (
                <Text>
                  {sep}
                  <Text color="suggestion" bold>
                    {step} …
                  </Text>
                </Text>
              ) : (
                <Text>
                  {sep}
                  <Text color="success" dimColor>
                    {step} ✔
                  </Text>
                </Text>
              )
            })}
          </Text>
        )}

        <Box marginTop={1}>
          <Text>
            <Text color={isAllDone ? 'success' : 'suggestion'}>{bar}</Text>
            <Text dimColor>{rest}</Text> <Text bold>{count}</Text>
          </Text>
        </Box>
        <Text>
          完了 <Text color="success" bold>{done}</Text>
          <Text dimColor>　/　</Text>残り <Text bold>{left}</Text>
        </Text>

        {counts.length > 0 && (
          <Box marginTop={1}>
            {pressable(
              'rulings',
              counts.map(({ kind, n }) => `${RULING_LABEL[kind]} ${n}`).join('・'),
            )}
          </Box>
        )}

        {open === 'tasks' && (
          <Box flexDirection="column" marginTop={1}>
            {rule}
            {list.map((one, i) => (
              <Text
                wrap="truncate-end"
                dimColor={one.status === 'completed'}
                bold={one.status === 'in_progress'}
                color={one.status === 'in_progress' ? 'suggestion' : undefined}
              >
                {MARK[one.status]} {numberOf(one, i)}. {one.subject}
              </Text>
            ))}
          </Box>
        )}
        {open === 'rulings' && (
          <Box flexDirection="column" marginTop={1}>
            {rule}
            {rulings.map(one => (
              <Text wrap="wrap">
                <Text color={RULING_COLOR[one.kind]} bold>
                  [{RULING_LABEL[one.kind]}]
                </Text>{' '}
                {one.text}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
