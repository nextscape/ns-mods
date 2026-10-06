export type Level = 'low' | 'medium' | 'high' | 'xhigh'

// One numbered or lettered choice the answer offered ("2. テストを追加する").
export type Option = { key: string; text: string }

// What one main-thread turn left behind, for judging the next one.
// `options` and `asks` are absent in state saved before 0.4.
export type TurnSignals = {
  level: Level | null
  steps: number
  tools: number
  toolErrors: number
  durationMs: number
  request: string
  answerTail: string
  options?: Option[]
  asks?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'effort-router': { prev: TurnSignals | null; recent: Array<Level | null> }
  }
}
