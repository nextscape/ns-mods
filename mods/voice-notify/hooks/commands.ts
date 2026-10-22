// /voice-notify: muting, and setting up, checking and removing what lives
// outside the plugin (the engine at logon, the hotkey).

import type { EngineInterface } from 'claude-code'

import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  fillTemplate,
  fromScript,
  installScriptArgv,
  plistPath,
  systemdValue,
  unitPath,
  windowsInstallArgs,
  xml,
} from './autostart'
import { engineVersion, findEngine, startEngine } from './engine'
import { generatePhrases, phraseState } from './generate'
import { background, context, detectOs, homeRoot, isMuted, loadConfig, removeFiles, run, writeLog } from './io'
import { slashPath, winPath } from './os'
import type { Os } from './os'
import type { Ctx, Runtime } from './runtime'
import { findLinuxPlayer, speakPhrase } from './speak'
import {
  HINT,
  INSTALL_HINT,
  LEGACY_BIN,
  LEGACY_STATE_DIRS,
  creditLine,
  doctorReport,
  ng,
  ok,
  parseCommand,
  step,
  unknownArg,
  voiceStatus,
  warn,
} from './setup'
import type { SetupAction, VoiceAction } from './setup'
import { isErrorLine } from './store'
import type { FoundEngine } from './voicevox'

export async function runCommand($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const cmd = parseCommand(args)
  if (!cmd) return unknownArg(args)
  return cmd.kind === 'voice' ? runVoice($, rt, cmd.action) : runSetup($, rt, cmd.action)
}

async function runVoice($: EngineInterface, rt: Runtime, action: VoiceAction): Promise<string> {
  const ctx = await context($, rt)
  if (!ctx) return `config.json を読めません。${HINT.doctor} で確かめてください。`
  const muted = await isMuted($, ctx.root)
  if (action === 'status') return voiceStatus(ctx.cfg, ctx.os, muted)
  const mute = action === 'toggle' ? !muted : action === 'mute'
  if (mute) {
    // Said before it goes quiet.
    await speakPhrase($, ctx, 'final', ['mute'], 'voice')
    await $.fs.write(`${ctx.root}/state/mute`, new Date(await $.clock.now()).toISOString())
  } else {
    await removeFiles($, ctx.os, [`${ctx.root}/state/mute`])
    await speakPhrase($, ctx, 'final', ['unmute'], 'voice')
  }
  await writeLog($, ctx, 'INFO', 'voice', '手動ミュートを切り替え')
  return mute ? '音声通知: 停止しました' : '音声通知: 再開しました'
}

async function runSetup($: EngineInterface, rt: Runtime, action: SetupAction): Promise<string> {
  const root = await homeRoot($)
  if (!root) return ng('ホームが決まりません（USERPROFILE も HOME もありません）')
  // Removing works even with a broken config.json.
  if (action === 'remove') return (await removeAutostartAndHotkey($, root, await detectOs($, rt))).join('\n')
  const ctx = await context($, rt)
  if (!ctx) {
    const loaded = await loadConfig($, root)
    const why = 'error' in loaded ? loaded.error : ''
    return [step('設定（config.json）'), ng(`config.json を読めません（${why}）。直してから、もう一度実行してください: ${root}/config.json`)].join('\n')
  }
  return (action === 'doctor' ? await doctor($, ctx) : await install($, ctx, action === 'force')).join('\n')
}

async function legacyFiles($: EngineInterface, root: string): Promise<string[]> {
  const out: string[] = []
  for (const d of LEGACY_STATE_DIRS) {
    try {
      for (const f of await $.fs.list(`${root}/state/${d}`)) if (f.kind === 'file') out.push(`${root}/state/${d}/${f.name}`)
    } catch {
      // Not there.
    }
  }
  for (const f of LEGACY_BIN) if (await $.fs.exists(`${root}/bin/${f}`)) out.push(`${root}/bin/${f}`)
  return out
}

async function install($: EngineInterface, ctx: Ctx, force: boolean): Promise<string[]> {
  const port = ctx.cfg.enginePort
  const out = ['voice-notify を導入します', `ホーム: ${ctx.root}`, step('1. ホーム'), ok(`config.json: ${ctx.root}/config.json`)]
  const legacy = await legacyFiles($, ctx.root)
  if (legacy.length) {
    out.push((await removeFiles($, ctx.os, legacy)) ? ok(`0.2.0 の残りを消しました（${legacy.length} 件）`) : warn(`0.2.0 の残りを消せないものがありました（${legacy.length} 件のうち）。${ctx.root}/state と bin を確かめてください`))
  }
  out.push(step('2. VOICEVOX'))
  const engine = await findEngine($, ctx.cfg, ctx.os)
  if (!engine) {
    out.push(ng(`VOICEVOX が見つかりません。次の方法で導入してから、もう一度 ${HINT.setup} を実行してください。`), `   ${INSTALL_HINT[ctx.os]}`)
    if (ctx.os !== 'linux') out.push('   別の場所に入れた場合は、config.json の enginePath に ENGINE（vv-engine の run）の絶対パスを書いてください。')
    return out
  }
  out.push(ok(engine.path ?? `場所は不明（port ${port} で応答あり）`))
  out.push(step('3. ENGINE の起動'))
  if (engine.running) out.push(ok(`すでに起動済み (port ${port})`))
  else if (engine.path && (await startEngine($, ctx.cfg, ctx.os, engine.path))) out.push(ok('起動しました'))
  else {
    out.push(ng('ENGINE が起動しませんでした（60秒待っても応答なし）'))
    return out
  }
  out.push(step('4. 定型フレーズ'))
  const st = await phraseState($, ctx)
  if (!force && st.current && st.missing === 0) out.push(ok(`生成済み（作り直すときは ${HINT.force}）`))
  else if (st.busy) out.push(ok(`別のセッションが生成中です（${st.progress?.done ?? 0}/${st.total}）`))
  else {
    void background($, ctx.rt, 'phrases', generatePhrases($, ctx, force))
    out.push(ok(`裏で生成を始めました（初回は数分）。進み具合は ${HINT.doctor} の「定型フレーズ」で確認できます`))
  }
  out.push(...(await installAutostartAndHotkey($, ctx, engine)))
  out.push('', '導入しました。音声通知は、このセッションからすぐ有効です。', `  診断: ${HINT.doctor}`, `  撤去: ${HINT.remove}`)
  return out
}

// Reports only; changes nothing.
async function doctor($: EngineInterface, ctx: Ctx): Promise<string[]> {
  const port = ctx.cfg.enginePort
  const curl = await run($, [ctx.os === 'windows' ? 'curl.exe' : 'curl', '--version'])
  const log = await $.fs.read(`${ctx.root}/notify.log`).catch(() => '')
  return doctorReport({
    pluginRoot: $.plugin.root,
    root: ctx.root,
    os: ctx.os,
    player: ctx.os === 'linux' ? await findLinuxPlayer($, ctx.rt) : null,
    curl: curl.exitCode === 0 ? (curl.stdout.split('\n')[0] ?? '').trim() : null,
    engine: await findEngine($, ctx.cfg, ctx.os),
    port,
    version: await engineVersion($, port),
    phrases: await phraseState($, ctx),
    autostart: await autostartStatus($, ctx),
    muted: await isMuted($, ctx.root),
    legacy: (await legacyFiles($, ctx.root)).length,
    errors: log.trimEnd().split('\n').slice(-200).filter(isErrorLine),
    credit: creditLine(ctx.cfg),
  })
}

// ---- The engine at logon, and the hotkey ----

// Windows' task and hotkey go through install.ps1 (ScheduledTask and
// WScript.Shell are reachable only from PowerShell).
async function installScript($: EngineInterface, args: readonly string[]): Promise<string[]> {
  const r = await run($, installScriptArgv($.plugin.root, args), { timeoutMs: 60_000 })
  return r.exitCode === 0 ? fromScript(r.stdout) : [ng(`install.ps1 が失敗: ${r.stderr.trim() || r.exitCode}`)]
}

async function homeDir($: EngineInterface): Promise<string> {
  return slashPath((await $.env.get('HOME')) ?? '')
}

async function guiDomain($: EngineInterface): Promise<string> {
  return `gui/${(await run($, ['id', '-u'])).stdout.trim()}`
}

async function installAutostartAndHotkey($: EngineInterface, ctx: Ctx, engine: FoundEngine): Promise<string[]> {
  const out = [step('5. ログオン時の ENGINE 起動とホットキー')]
  if (ctx.os === 'windows') return [...out, ...(await installScript($, windowsInstallArgs(ctx.root, ctx.cfg.hotKey, engine.path)))]
  if (!engine.path) return [...out, ok('外部の ENGINE（Docker など）を使うので、ログオン時の起動は登録しません')]
  const home = await homeDir($)
  const values = { LABEL: LAUNCHD_LABEL, RUN: engine.path, DIR: engine.path.slice(0, engine.path.lastIndexOf('/')) }
  if (ctx.os === 'macos') {
    const plist = plistPath(home)
    await $.fs.write(plist, fillTemplate(await $.fs.read(`${$.plugin.root}/scripts/macos/voice-notify-engine.plist`), values, xml))
    const domain = await guiDomain($)
    // Fails when nothing was registered before, which is fine.
    await run($, ['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`])
    const r = await run($, ['launchctl', 'bootstrap', domain, plist])
    out.push(r.exitCode === 0 ? ok(`launchd: ${plist}`) : ng(`launchctl bootstrap が失敗: ${r.stderr.trim()}`))
  } else {
    const unit = unitPath(home)
    await $.fs.write(unit, fillTemplate(await $.fs.read(`${$.plugin.root}/scripts/linux/voice-notify-engine.service`), values, systemdValue))
    await run($, ['systemctl', '--user', 'daemon-reload'])
    const r = await run($, ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT])
    out.push(r.exitCode === 0 ? ok(`systemd: ${unit}`) : ng(`systemctl --user enable が失敗: ${r.stderr.trim()}`))
  }
  out.push(ok(`ホットキーは Windows だけです。ミュートは ${HINT.voice} を使ってください`))
  return out
}

async function removeAutostartAndHotkey($: EngineInterface, root: string, os: Os): Promise<string[]> {
  const out = ['voice-notify を撤去します（ホームは残します）']
  if (os === 'windows') return [...out, ...(await installScript($, ['-Action', 'remove', '-VHome', winPath(root)]))]
  const home = await homeDir($)
  if (os === 'macos') {
    await run($, ['launchctl', 'bootout', `${await guiDomain($)}/${LAUNCHD_LABEL}`])
    await removeFiles($, os, [plistPath(home)])
    out.push(ok('launchd の登録を外しました'))
  } else {
    await run($, ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT])
    await removeFiles($, os, [unitPath(home)])
    await run($, ['systemctl', '--user', 'daemon-reload'])
    out.push(ok('systemd の登録を外しました'))
  }
  return out
}

async function autostartStatus($: EngineInterface, ctx: Ctx): Promise<string[]> {
  const out = [step('常駐まわり')]
  if (ctx.os === 'windows') return [...out, ...(await installScript($, ['-Action', 'status', '-VHome', winPath(ctx.root)]))]
  const home = await homeDir($)
  if (ctx.os === 'macos') {
    const plist = plistPath(home)
    out.push((await $.fs.exists(plist)) ? ok(`ログオン時起動（launchd）: ${plist}`) : warn('ログオン時起動（launchd）なし'))
  } else {
    const r = await run($, ['systemctl', '--user', 'is-enabled', SYSTEMD_UNIT])
    out.push(r.exitCode === 0 ? ok(`ログオン時起動（systemd）: ${r.stdout.trim()}`) : warn('ログオン時起動（systemd）なし'))
  }
  return out
}
