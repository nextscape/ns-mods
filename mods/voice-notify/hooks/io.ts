// The I/O every other part leans on: commands, files, notify.log, the home,
// the settings and the OS.

import type { EngineInterface } from 'claude-code'

import { DEFAULT_CONFIG, parseConfig, resolveConfig, voiceHome } from './config'
import type { Config } from './config'
import { moveArgv, osFrom, removeArgv } from './os'
import type { Os } from './os'
import type { Ctx, LogTo, Runtime } from './runtime'
import { appendLog, logLine } from './store'
import type { Level } from './store'

type RunInit = Parameters<EngineInterface['process']['run']>[1]
export type RunResult = { exitCode: number; stdout: string; stderr: string }

// An outside command. $.process.run rejects when the command cannot start (it
// is not installed); that reads as a failed exit (-1), so doctor can say what
// is missing instead of stopping.
export async function run($: EngineInterface, argv: readonly string[], init?: RunInit): Promise<RunResult> {
  try {
    return await $.process.run(argv, init)
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err) }
  }
}

// Whether the files are gone (true when there was nothing to delete).
export async function removeFiles($: EngineInterface, os: Os, paths: readonly string[]): Promise<boolean> {
  const cmd = removeArgv(os, $.plugin.root, paths)
  return !cmd || (await run($, cmd.argv, cmd.stdin ? { stdin: cmd.stdin } : undefined)).exitCode === 0
}

export async function moveFile($: EngineInterface, os: Os, from: string, to: string): Promise<RunResult> {
  const cmd = moveArgv(os, $.plugin.root, from, to)
  return run($, cmd.argv, cmd.stdin ? { stdin: cmd.stdin } : undefined)
}

// Never throws: a log line that cannot be written must not stop the speech.
export async function writeLog($: EngineInterface, to: LogTo, level: Level, event: string, msg: string): Promise<void> {
  const { rt, root } = to
  try {
    rt.pendingLog.push({ root, line: logLine(new Date(await $.clock.now()), level, event, msg) })
  } catch {
    return
  }
  const release = await rt.logGate.enter()
  try {
    // A call that went first may have written this line along with its own.
    const batch = rt.pendingLog.splice(0)
    for (const r of new Set(batch.map(b => b.root))) {
      const path = `${r}/notify.log`
      const old = await $.fs.read(path).catch(() => '')
      await $.fs.write(path, appendLog(old, batch.filter(b => b.root === r).map(b => b.line)))
    }
  } catch (err) {
    try {
      $.ui.log(`voice-notify: notify.log に書けない (${String(err)})`, { to: 'debug' })
    } catch {
      // The module has been unloaded: nowhere left to say it.
    }
  } finally {
    release()
  }
}

// Work run in the background (no hook waits for it). A failure goes to
// notify.log as ERR; failing that (no home), to the debug log; failing that
// (the module has been unloaded), nowhere.
export async function background($: EngineInterface, rt: Runtime, event: string, work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch (err) {
    try {
      const root = await homeRoot($)
      if (root) return await writeLog($, { rt, root }, 'ERR', event, String(err))
    } catch {
      // The home is unknown.
    }
    try {
      $.ui.log(`voice-notify: ${event}: ${String(err)}`, { to: 'debug' })
    } catch {
      // Nowhere left to say it.
    }
  }
}

export async function homeRoot($: EngineInterface): Promise<string | null> {
  return voiceHome(await $.env.get('VOICE_NOTIFY_HOME'), await $.env.get('USERPROFILE'), await $.env.get('HOME'))
}

export async function detectOs($: EngineInterface, rt: Runtime): Promise<Os> {
  if (rt.os) return rt.os
  const env = await $.env.get('OS')
  // With no uname to run, it reads as Linux.
  const uname = env === 'Windows_NT' ? '' : (await run($, ['uname', '-s'])).stdout
  rt.os = osFrom(env, uname)
  return rt.os
}

// config.json over the defaults. Read first; only a missing file is written
// from the defaults (one that exists but cannot be read is left alone).
export async function loadConfig($: EngineInterface, root: string): Promise<{ cfg: Config } | { error: string }> {
  const path = `${root}/config.json`
  try {
    let text: string
    try {
      text = await $.fs.read(path)
    } catch (err) {
      if (await $.fs.exists(path)) return { error: String(err) }
      text = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`
      await $.fs.write(path, text)
    }
    return { cfg: resolveConfig(parseConfig(text)) }
  } catch (err) {
    return { error: String(err) }
  }
}

// What an event works with, or null when there is no home or config.json is
// broken (said once in notify.log until it is fixed).
export async function context($: EngineInterface, rt: Runtime): Promise<Ctx | null> {
  const root = await homeRoot($)
  if (!root) return null
  const loaded = await loadConfig($, root)
  if ('error' in loaded) {
    if (!rt.warnedConfig) {
      rt.warnedConfig = true
      await writeLog($, { rt, root }, 'ERR', 'config', `config.json を読めないので鳴らさない: ${loaded.error}`)
    }
    return null
  }
  rt.warnedConfig = false
  return { rt, root, cfg: loaded.cfg, os: await detectOs($, rt) }
}

export async function isMuted($: EngineInterface, root: string): Promise<boolean> {
  return $.fs.exists(`${root}/state/mute`)
}
