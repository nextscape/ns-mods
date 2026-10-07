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

  test('removeArgv uses del on Windows and rm elsewhere, keeping spaces in one argument', () => {
    expect(removeArgv('windows', ['C:/vn/a.wav', 'C:/vn/b c.wav'])).toEqual(['cmd', '/d', '/c', 'del', '/f', '/q', 'C:\\vn\\a.wav', 'C:\\vn\\b c.wav'])
    expect(removeArgv('linux', ['/h/x.wav'])).toEqual(['rm', '-f', '--', '/h/x.wav'])
    expect(removeArgv('macos', [])).toBeNull()
  })

  test('micInUseFrom: an app with a start and no stop is using the microphone', () => {
    expect(micInUseFrom(REG)).toBe('C:#Apps#meet.exe')
    expect(micInUseFrom(REG.replace('0x0', '0x1'))).toBeNull()
    expect(micInUseFrom('')).toBeNull()
    expect(MIC_QUERY.slice(0, 2)).toEqual(['reg', 'query'])
    expect(MIC_QUERY.at(-1)).toBe('/s')
  })
})
