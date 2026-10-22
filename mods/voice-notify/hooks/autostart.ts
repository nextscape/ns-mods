// Starting the engine at logon (Windows: a scheduled task; macOS: launchd;
// Linux: a systemd user service) and the hotkey (Windows only), as pure
// functions; commands.ts runs them.

import { psArgv, winPath } from './os'
import { ng, ok, warn } from './setup'

export const LAUNCHD_LABEL = 'jp.nextscape.voice-notify.engine'
export const SYSTEMD_UNIT = 'voice-notify-engine.service'

export function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// A value in a systemd unit: % starts a specifier (%h and so on), so it doubles.
export function systemdValue(s: string): string {
  return s.replace(/%/g, '%%')
}

// Fills each {{KEY}} of a template, escaping the value for the file's format
// (xml for the plist, systemdValue for the unit).
export function fillTemplate(template: string, values: Record<string, string>, escape: (s: string) => string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (all, k: string) => (k in values ? escape(values[k]!) : all))
}

// install.ps1's "OK / WARN / NG <text>" lines in the setup format.
export function fromScript(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter(Boolean).map(l => {
    const m = /^(OK|WARN|NG) (.*)$/.exec(l)
    if (!m) return `   ${l}`
    return m[1] === 'OK' ? ok(m[2]!) : m[1] === 'WARN' ? warn(m[2]!) : ng(m[2]!)
  })
}

export function installScriptArgv(pluginRoot: string, args: readonly string[]): string[] {
  return psArgv(pluginRoot, 'install.ps1', args)
}

// With no known engine path (an engine run elsewhere), no task is registered.
export function windowsInstallArgs(root: string, hotKey: string, enginePath: string | null): string[] {
  return ['-Action', 'install', '-VHome', winPath(root), '-HotKey', hotKey, ...(enginePath ? ['-EnginePath', winPath(enginePath)] : [])]
}

export function plistPath(home: string): string {
  return `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`
}

export function unitPath(home: string): string {
  return `${home}/.config/systemd/user/${SYSTEMD_UNIT}`
}
