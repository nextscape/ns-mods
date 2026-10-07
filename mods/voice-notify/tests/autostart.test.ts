import { describe, expect, test } from 'claude-code/testing'

import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  fillTemplate,
  fromScript,
  installScriptArgv,
  plistPath,
  unitPath,
  windowsInstallArgs,
  xml,
} from '../hooks/autostart'

describe('autostart', () => {
  test('fillTemplate replaces every {{KEY}} through the escape it is given; unknown keys stay', () => {
    expect(fillTemplate('<s>{{RUN}}</s><s>{{RUN}}</s>{{NONE}}', { RUN: '/a&b/run' }, xml)).toBe('<s>/a&amp;b/run</s><s>/a&amp;b/run</s>{{NONE}}')
    expect(fillTemplate('ExecStart="{{RUN}}"', { RUN: '/a&b/run' }, s => s)).toBe('ExecStart="/a&b/run"')
    expect(xml('<a & b>')).toBe('&lt;a &amp; b&gt;')
  })

  test('fromScript turns install.ps1 lines into the setup format', () => {
    expect(fromScript('OK タスク\r\nWARN なし\nNG 失敗\nその他\n')).toEqual(['   OK   タスク', '   注意 なし', '   NG   失敗', '   その他'])
  })

  test('installScriptArgv and windowsInstallArgs: the engine path only when it is known', () => {
    expect(installScriptArgv('C:/p', ['-Action', 'status'])).toEqual([
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\p\\scripts\\windows\\install.ps1', '-Action', 'status',
    ])
    expect(windowsInstallArgs('C:/vn', 'CTRL+ALT+M', 'C:/v/run.exe')).toEqual([
      '-Action', 'install', '-VHome', 'C:\\vn', '-HotKey', 'CTRL+ALT+M', '-EnginePath', 'C:\\v\\run.exe',
    ])
    expect(windowsInstallArgs('C:/vn', 'CTRL+ALT+M', null)).toEqual(['-Action', 'install', '-VHome', 'C:\\vn', '-HotKey', 'CTRL+ALT+M'])
  })

  test('launchd and systemd files live under the home', () => {
    expect(LAUNCHD_LABEL).toBe('jp.nextscape.voice-notify.engine')
    expect(plistPath('/Users/u')).toBe('/Users/u/Library/LaunchAgents/jp.nextscape.voice-notify.engine.plist')
    expect(SYSTEMD_UNIT).toBe('voice-notify-engine.service')
    expect(unitPath('/home/u')).toBe('/home/u/.config/systemd/user/voice-notify-engine.service')
  })
})
