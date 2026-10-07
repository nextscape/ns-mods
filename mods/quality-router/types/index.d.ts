export type Level = 'medium' | 'high' | 'xhigh' | 'max'
export type Effort = 'low' | Level
export type Top = 'opus' | 'fable'

// What one main-loop turn left behind, for judging the next one.
export type TurnSignals = {
  level: Level | null
  judged: Level | null
  steps: number
  tools: number
  toolErrors: number
  durationMs: number
  request: string
  answerTail: string
}

export type ChildRecord = { tier: number; effort?: Effort }
export type RetryRecord = { count: number; tier: number }
export type SkillFloor = { level: Level; skill: string }

declare module 'claude-code' {
  interface PluginState {
    'quality-router': {
      prev: TurnSignals | null
      recent: Array<Level | null>
      skillFloor: SkillFloor | null
      children: Record<string, ChildRecord>
      retries: Record<string, RetryRecord>
    }
  }
}
