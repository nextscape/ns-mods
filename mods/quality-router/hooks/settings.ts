import type { Level, Top } from '../types'
import { isLevel, isTop } from './levels'

// Pure: no `$`. The loader follows `$` only into functions declared in the
// file that holds the hooks, never across an import, so the reads and writes
// of `$.store` and `$.settings` (loadSettings, saveSetting,
// effortRouterInstalled) live at the top of register.ts, built on
// SETTING_KEYS, parseSettings and mentionsEffortRouter here.

export type Toggle = 'on' | 'off'
export type Settings = { mode: Toggle; gate: Toggle; guard: Toggle; floor: Level; ceiling: Level; top: Top }

// The guard is off by default: it moves the main loop to a top model, which
// not every plan or budget wants. `/qr guard on` turns it on.
export const DEFAULTS: Settings = { mode: 'on', gate: 'on', guard: 'off', floor: 'medium', ceiling: 'max', top: 'opus' }
export const SETTING_KEYS: ReadonlyArray<keyof Settings> = ['mode', 'gate', 'guard', 'floor', 'ceiling', 'top']

const isToggle = (value: unknown): value is Toggle => value === 'on' || value === 'off'

export function parseSettings(values: Partial<Record<keyof Settings, unknown>>): Settings {
  return {
    mode: isToggle(values.mode) ? values.mode : DEFAULTS.mode,
    gate: isToggle(values.gate) ? values.gate : DEFAULTS.gate,
    guard: isToggle(values.guard) ? values.guard : DEFAULTS.guard,
    floor: isLevel(values.floor) ? values.floor : DEFAULTS.floor,
    ceiling: isLevel(values.ceiling) ? values.ceiling : DEFAULTS.ceiling,
    top: isTop(values.top) ? values.top : DEFAULTS.top,
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

// A CLAUDE_CODE_PLUGIN_DIRS list: `;` between entries on Windows, `:` on
// POSIX. A drive letter's colon (`C:/...`, `C:\...`) belongs to its path.
function pluginDirs(value: string): string[] {
  const dirs: string[] = []
  for (const raw of value.split(/[;:]/)) {
    const part = raw.trim()
    const prev = dirs.pop()
    if (prev === undefined) dirs.push(part)
    else if (/^[A-Za-z]$/.test(prev) && /^[\\/]/.test(part)) dirs.push(`${prev}:${part}`)
    else dirs.push(prev, part)
  }
  return dirs.filter(dir => dir !== '')
}

// Installed means loaded as a plugin: a CLAUDE_CODE_PLUGIN_DIRS entry, or an
// enabledPlugins key set to true. A path elsewhere (permissions) does not
// count, nor does a plugin turned off. Takes ~/.claude/settings.json as text,
// or as the object `$.settings.read({ source: 'user' })` answers.
export function mentionsEffortRouter(settings: unknown): boolean {
  let json: unknown = settings
  if (typeof settings === 'string') {
    try {
      json = JSON.parse(settings)
    } catch {
      return false
    }
  }
  const o = record(json)
  const dirs = record(o.env).CLAUDE_CODE_PLUGIN_DIRS
  const inDirs = typeof dirs === 'string' && pluginDirs(dirs).some(dir => /(^|[\\/])effort-router[\\/]?$/.test(dir))
  const inPlugins = Object.entries(record(o.enabledPlugins)).some(
    ([key, enabled]) => enabled === true && key.split('@')[0] === 'effort-router',
  )
  return inDirs || inPlugins
}
