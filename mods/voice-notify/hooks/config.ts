// The settings: the shipped defaults, how a person's config.json lays over
// them, and where the home is. Pure functions only (unit-tested directly).
//
// DEFAULT_CONFIG is the one place a default lives: the first run writes it to
// <home>/config.json for the person to edit, and every load lays that file
// over it, so the code reads each setting without a fallback of its own.

export type Speaker = { id: number; label?: string; credit?: string }

// A folder of phrases: an array is its NN.wav files, an object its subfolders.
export type PhraseTree = { [name: string]: readonly string[] | PhraseTree }

export type SpeechConfig = {
  shortSentenceChars: number
  maxTwoSentenceChars: number
  briefMaxSeconds: number
  readings: Record<string, string>
  lowercaseMinLength: number
  keepUppercase: string[]
  summarize: boolean
  summarizeEvents: string[]
  summaryModel: string
  summaryMinChars: number
  summaryMaxChars: number
  interimMaxChars: number
  interimPrompt: string[]
  summaryTimeoutSec: number
  summaryPrompt: string[]
}

export type Config = {
  speaker: string
  speakerInterim: string
  speedScale: number
  pitchScale: number
  intonationScale: number
  enginePort: number
  // Set only when the engine is not where setup looks for it.
  enginePath?: string
  hotKey: string
  speakers: Record<string, Speaker>
  phrases: PhraseTree
  subagent: { debounceSeconds: number; defaultLabel: string }
  speech: SpeechConfig
  mute: { whenMicInUse: boolean }
  cacheMaxFiles: number
  playback: { leadSilenceMs: number }
  notification: { toolLabels: Record<string, string> }
}

export const DEFAULT_CONFIG: Config = {
  speaker: 'metan',
  speakerInterim: 'zundamon',
  speedScale: 1.3,
  pitchScale: 0,
  intonationScale: 1,
  enginePort: 50021,
  hotKey: 'CTRL+ALT+M',
  speakers: {
    metan: {
      id: 2,
      label: '四国めたん(ノーマル)',
      credit: 'VOICEVOX:四国めたん',
    },
    zundamon: {
      id: 3,
      label: 'ずんだもん(ノーマル)',
      credit: 'VOICEVOX:ずんだもん',
    },
  },
  phrases: {
    stop: {
      done: [
        '作業が完了しました。要点をお伝えします。',
        'ひと通り終わりました。内容をお伝えします。',
        'お待たせしました。まとめてご報告します。',
        '一区切りつきました。要点をお伝えします。',
        '完了しました。何をしたかお伝えします。',
        'できました。結果をまとめてご報告します。',
      ],
      ask: [
        '確認したいことがあります。内容をお伝えします。',
        'ご判断いただきたい点があります。ご説明します。',
        '一度ご相談させてください。状況をお伝えします。',
        '進め方を決めたい点があります。ご説明します。',
        'お伺いしたいことがあります。順にお伝えします。',
      ],
      trouble: [
        'うまくいかない点があります。状況をお伝えします。',
        '問題が見つかりました。内容をご報告します。',
        '引っかかっている点があります。ご説明します。',
        '想定どおりに進んでいません。状況をお伝えします。',
      ],
      solo: [
        '完了しました。',
        '終わりました。',
        'できました。',
        'お待たせしました。',
        'ひと通り終わっています。',
        '作業はこれで完了です。',
      ],
      interim: [
        '途中経過です。',
        '途中のご報告です。',
        'いまの状況です。',
      ],
      brief: {
        done: [
          '完了しました。',
          '終わりました。',
          'できました。',
          'はい、できました。',
        ],
        ask: [
          '確認をお願いします。',
          'ご判断をお願いします。',
          'お返事をお待ちしています。',
        ],
        trouble: [
          'うまくいきませんでした。',
          '問題が出ています。',
        ],
        interim: [
          '引き続き進めています。',
          '作業を続けています。',
          'まだ続きがあります。',
        ],
      },
    },
    notification: [
      '確認をお願いします。',
      '入力をお待ちしています。',
      '確認が必要です。',
    ],
    task: [
      'タスクが完了しました。',
      'タスクが一件終わりました。',
    ],
    permission: [
      '許可をお願いします。',
      '確認をお願いします。',
    ],
    idle: [
      '入力をお待ちしています。',
    ],
    failure: [
      'エラーが発生しました。',
    ],
    mute: [
      '音声通知を停止します。',
    ],
    unmute: [
      '音声通知を再開します。',
    ],
  },
  subagent: {
    debounceSeconds: 8,
    defaultLabel: 'エージェント',
  },
  speech: {
    shortSentenceChars: 20,
    maxTwoSentenceChars: 60,
    briefMaxSeconds: 30,
    readings: {
      FIX: 'フィックス',
      TASK: 'タスク',
      DONE: 'ダン',
      STATUS: 'ステータス',
      NOTE: 'ノート',
      PASS: 'パス',
      FAIL: 'フェイル',
      TODO: 'トゥードゥー',
      README: 'リードミー',
      npm: 'エヌピーエム',
      pnpm: 'ピーエヌピーエム',
      npx: 'エヌピーエックス',
      tsc: 'ティーエスシー',
      json: 'ジェイソン',
      css: 'シーエスエス',
      url: 'ユーアールエル',
      cli: 'シーエルアイ',
      sdk: 'エスディーケー',
      api: 'エーピーアイ',
      jsx: 'ジェイエスエックス',
      tsx: 'ティーエスエックス',
      mcp: 'エムシーピー',
      llm: 'エルエルエム',
      utf: 'ユーティーエフ',
    },
    lowercaseMinLength: 5,
    keepUppercase: [
      'HTTPS',
      'DPAPI',
    ],
    summarize: true,
    summarizeEvents: [
      'stop',
      'agentstop',
    ],
    summaryModel: 'haiku',
    summaryMinChars: 80,
    summaryMaxChars: 60,
    interimMaxChars: 30,
    interimPrompt: [
      '',
      '今回は途中経過なので、ひと言で報告します。「〜しました。」「〜中です。」のような1文だけ、{maxChars}文字以内で出力してください。コミットID・ファイル名・パスは聞いても分からないので含めず、数字や固有名詞は最も大事な1つだけ残してください。',
    ],
    summaryTimeoutSec: 15,
    summaryPrompt: [
      '次に示すのは、あなたが依頼者に向けて書いた作業報告です。',
      'いまから同じ内容を、作業した本人として口頭で報告します。',
      '聞き手に語りかける「です・ます」調で、日本語1〜2文・合計{maxChars}文字以内にしてください。',
      '数字や固有名詞など、聞いて役に立つ具体は残してください。',
      '',
      '相手の入力や判断を待っている内容のときだけ、最後に短く呼びかけてください',
      '（ご判断をお願いします／どちらにしましょうか／ご確認ください など）。',
      '待っていないときは呼びかけを付けず、報告だけで終えてください。',
      '',
      '例:',
      '  良い: 要約の生成が1秒を切りました。体感の待ち時間はなくなっています。',
      '  良い: 原因は compact の誤検知でした。開始を見ていない停止は無視するようにしています。',
      '  良い: テストが3件失敗しています。仕様の意図を確認したいので、ご判断をお願いします。',
      '  悪い: 要約処理の高速化とモデル選定を実施しました。',
      '  悪い: compact の誤検知について調査と修正を行いました。',
      '  悪い: 修正が完了しました。詳細は資料をご確認ください。',
      '',
      '報告文だけを出力し、前置き・記号・箇条書き・引用符は使わないでください。',
    ],
  },
  mute: {
    whenMicInUse: true,
  },
  cacheMaxFiles: 200,
  playback: {
    leadSilenceMs: 600,
  },
  notification: {
    toolLabels: {
      Bash: 'コマンド実行',
      Edit: 'ファイル編集',
      Write: 'ファイル書き込み',
      Read: 'ファイル読み取り',
      WebFetch: 'ウェブ取得',
      WebSearch: 'ウェブ検索',
    },
  },
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

// Valid JSON that is not an object (null, an array) is a broken config too.
export function parseConfig(text: string): Record<string, unknown> {
  const v: unknown = JSON.parse(stripBom(text))
  if (!isObject(v)) throw new Error('config.json の中身がオブジェクトではない')
  return v
}

// The person's settings over the defaults: objects merge key by key; arrays
// and values are the person's (so a config.json from an older version runs
// with the keys it lacks at their defaults).
export function mergeConfig(defaults: Record<string, unknown>, user: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults }
  for (const [k, v] of Object.entries(user)) {
    const d = defaults[k]
    out[k] = isObject(d) && isObject(v) ? mergeConfig(d, v) : v
  }
  return out
}

type Kind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' | 'undefined'

const kindOf = (v: unknown): Kind => (v === null ? 'null' : Array.isArray(v) ? 'array' : (typeof v as Kind))

const KIND_NAME: Record<Kind, string> = {
  string: '文字列',
  number: '数値',
  boolean: ' true か false ',
  array: '配列',
  object: 'オブジェクト',
  null: 'null',
  undefined: '値',
}

// Folders the person may reshape freely (an array where the default has
// subfolders silences them all).
const FREE_FORM = new Set(['phrases'])

// What is wrong with merged settings, one line each (empty when nothing is):
// each key keeps the kind its default has, and both voices name a speaker
// that `speakers` defines with a numeric id.
export function configErrors(merged: Record<string, unknown>, defaults: Record<string, unknown> = DEFAULT_CONFIG, at = ''): string[] {
  const out: string[] = []
  for (const [k, d] of Object.entries(defaults)) {
    const v = merged[k]
    const path = at ? `${at}.${k}` : k
    if (kindOf(v) !== kindOf(d)) out.push(`${path} は${KIND_NAME[kindOf(d)]}にする`)
    else if (isObject(d) && isObject(v) && !FREE_FORM.has(path)) out.push(...configErrors(v, d, path))
  }
  if (at !== '') return out
  if ('enginePath' in merged && typeof merged.enginePath !== 'string') out.push('enginePath は文字列にする')
  const speakers = isObject(merged.speakers) ? merged.speakers : {}
  for (const [name, one] of Object.entries(speakers)) {
    if (!isObject(one) || typeof one.id !== 'number') out.push(`speakers.${name}.id は数値にする`)
  }
  if (typeof merged.speaker === 'string' && !(merged.speaker in speakers)) out.push(`speaker の「${merged.speaker}」が speakers に無い`)
  return out
}

// The settings to run with, or an Error naming what to fix in config.json.
export function resolveConfig(user: Record<string, unknown>): Config {
  const merged = mergeConfig(DEFAULT_CONFIG, user)
  const errors = configErrors(merged)
  if (errors.length > 0) throw new Error(errors.join(' / '))
  return merged as Config
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// Where the settings and state live (the home): VOICE_NOTIFY_HOME, else
// ~/.claude/voice-notify.
export function voiceHome(envHome: string | undefined, userProfile: string | undefined, home: string | undefined): string | null {
  if (envHome && envHome.trim()) return norm(envHome.trim())
  const base = (userProfile && userProfile.trim()) || (home && home.trim())
  return base ? `${norm(base)}/.claude/voice-notify` : null
}
