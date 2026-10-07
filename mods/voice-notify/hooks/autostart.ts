// ログオン時の ENGINE 起動（Windows はタスク、macOS は launchd、Linux は systemd のユーザーサービス）と、
// ホットキー（Windows だけ）の形（純粋関数）。実行は register.ts。

import { ng, ok, warn } from './setup'

export const LAUNCHD_LABEL = 'jp.nextscape.voice-notify.engine'
export const SYSTEMD_UNIT = 'voice-notify-engine.service'

const win = (p: string) => p.replace(/\//g, '\\')

export function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ひな形の {{KEY}} を置き換える。値は書式に合わせて escape する（plist は XML、systemd の unit はそのまま）
export function fillTemplate(template: string, values: Record<string, string>, escape: (s: string) => string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (all, k: string) => (k in values ? escape(values[k]!) : all))
}

// install.ps1 の「OK / WARN / NG <文>」を setup の書式に直す
export function fromScript(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter(Boolean).map(l => {
    const m = /^(OK|WARN|NG) (.*)$/.exec(l)
    if (!m) return `   ${l}`
    return m[1] === 'OK' ? ok(m[2]!) : m[1] === 'WARN' ? warn(m[2]!) : ng(m[2]!)
  })
}

export function installScriptArgv(pluginRoot: string, args: readonly string[]): string[] {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', win(`${pluginRoot}/scripts/windows/install.ps1`), ...args]
}

// ENGINE の場所が分からない（外部の ENGINE）ときは、タスクを登録しない
export function windowsInstallArgs(root: string, hotKey: string, enginePath: string | null): string[] {
  return ['-Action', 'install', '-VHome', win(root), '-HotKey', hotKey, ...(enginePath ? ['-EnginePath', win(enginePath)] : [])]
}

export function plistPath(home: string): string {
  return `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`
}

export function unitPath(home: string): string {
  return `${home}/.config/systemd/user/${SYSTEMD_UNIT}`
}
