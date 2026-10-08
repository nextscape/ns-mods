import { describe, expect, test } from 'claude-code/testing'

import { MIC_QUERY, micInUseFrom, osFrom, removeArgv } from '../hooks/os'

const REG = [
  'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Tools#rec.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1d9a1b2c3d4e5f6',
  '    LastUsedTimeStop    REG_QWORD    0x1d9a1b2c3d4e5f7',
  '',
  'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Apps#meet.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1d9a1b2c3d4e5f6',
  '    LastUsedTimeStop    REG_QWORD    0x0',
].join('\r\n')

describe('os', () => {
  test('osFrom: Windows_NT, then uname', () => {
    expect(osFrom('Windows_NT', '')).toBe('windows')
    expect(osFrom(undefined, 'Darwin\n')).toBe('macos')
    expect(osFrom(undefined, 'Linux\n')).toBe('linux')
    expect(osFrom(undefined, 'FreeBSD')).toBe('linux')
  })

  test('removeArgv: Windows passes the paths on stdin to remove.ps1 (no cmd length limit, no & parsing); elsewhere rm', () => {
    const many = Array.from({ length: 200 }, (_, i) => `C:/ホーム/A&B %X%/phrases/metan/stop/done/${i}.wav`)
    expect(removeArgv('windows', 'C:/p', many)).toEqual({
      argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\p\\scripts\\windows\\remove.ps1'],
      stdin: many.map(p => p.replace(/\//g, '\\')).join('\n'),
    })
    expect(removeArgv('linux', '/p', ['/h/x.wav', '/h/a b.wav'])).toEqual({ argv: ['rm', '-f', '--', '/h/x.wav', '/h/a b.wav'], stdin: '' })
    expect(removeArgv('macos', '/p', [])).toBeNull()
  })

  test('micInUseFrom: an app with a start and no stop is using the microphone', () => {
    expect(micInUseFrom(REG)).toBe('C:#Apps#meet.exe')
    expect(micInUseFrom(REG.replace('0x0', '0x1'))).toBeNull()
    expect(micInUseFrom('')).toBeNull()
    expect(MIC_QUERY.slice(0, 2)).toEqual(['reg', 'query'])
    expect(MIC_QUERY.at(-1)).toBe('/s')
  })
})
