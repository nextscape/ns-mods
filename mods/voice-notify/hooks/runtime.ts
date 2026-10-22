// What the mod remembers while a session runs, made afresh by each register()
// call (a reload starts it over), and what each event works with (Ctx).

import type { Config } from './config'
import { Gate } from './gate'
import type { Os } from './os'

export type Runtime = {
  // Turns at work (idle notices wait while any runs), and main-conversation
  // /compact runs in progress (their turn ends are not read).
  working: Set<string>
  compacting: number
  // The main conversation's latest turn (see MainTurn), by turnId, which a
  // classic Stop belongs to.
  turns: Map<string, MainTurn>
  current: string | null
  os: Os | null
  // The Linux player found; one not found is not remembered, so a player
  // installed later plays without reopening the session.
  linuxPlayer: string | null
  // Said once until it changes: a broken config.json, no player.
  warnedConfig: boolean
  warnedNoPlayer: boolean
  // This session is making the phrases.
  generating: boolean
  // notify.log can only be read and written back whole ($.fs cannot append):
  // lines that arrive together are written in one go.
  pendingLog: Array<{ root: string; line: string }>
  logGate: Gate
  // Clips play one at a time in a session (play.ps1 / play.sh keep sessions apart).
  playGate: Gate
  // Subagent reports arriving together pass the debounce's look-then-record
  // one at a time.
  debounceGate: Gate
}

export function createRuntime(): Runtime {
  return {
    working: new Set(),
    compacting: 0,
    turns: new Map(),
    current: null,
    os: null,
    linuxPlayer: null,
    warnedConfig: false,
    warnedNoPlayer: false,
    generating: false,
    pendingLog: [],
    logGate: new Gate(),
    playGate: new Gate(),
    debounceGate: new Gate(),
  }
}

// What a main turn did that its turn.complete does not say: how many tools it
// called, and what its classic Stop said is still in flight (background
// shells, monitors, subagents, one-shot wakeups); null until the Stop comes.
// turn.complete and Stop may come in either order: `stopped` resolves on the
// Stop.
export type MainTurn = { tools: number; pending: number | null; stopped: Promise<void>; stop: () => void }

export function mainTurn(): MainTurn {
  let stop!: () => void
  const stopped = new Promise<void>(resolve => (stop = resolve))
  return { tools: 0, pending: null, stopped, stop }
}

// What an event that may speak works with: the home, its settings, the OS.
export type Ctx = { rt: Runtime; root: string; cfg: Config; os: Os }

// Enough to write to notify.log.
export type LogTo = Pick<Ctx, 'rt' | 'root'>
