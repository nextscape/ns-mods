export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type Task = { id: string; subject: string; status: TaskStatus }

// A ledger line the controller decided on: a ruling, a parked finding or a
// deferred minor.
export type RulingKind = 'ruling' | 'parked' | 'deferred'
export type Ruling = { kind: RulingKind; text: string }

// A Superpowers SDD plan's progress: `at` is its ledger's mtime, `title` the
// plan's heading.
export type SddProgress = {
  at: number
  title: string
  tasks: Task[]
  rulings: Ruling[]
}

// The step the controller last dispatched; `task` null once every task is
// done and the whole branch is reviewed.
export type StageStep =
  | 'implement'
  | 'review'
  | 'fix'
  | 'rereview'
  | 'final-review'
  | 'final-fix'
export type Stage = { task: number | null; step: StageStep; round: number }

export type Phase = 'design' | 'plan' | 'build' | 'finish'

// Which list the pane has unfolded.
export type OpenList = 'none' | 'tasks' | 'rulings'

declare module 'claude-code' {
  interface PluginState {
    'superpowers-progress': {
      tasks: Shaped<Task[]>
      tasksAt: number
      sdd: Shaped<SddProgress | null>
      stage: Shaped<Stage | null>
      phase: Phase | null
      openList: OpenList
    }
  }
}
