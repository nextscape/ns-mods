// 同じセッションの中で、非同期の処理を1つずつ通す関門（$ に触れない）。
// enter が返す関数を呼ぶと次が通る。
export class Gate {
  private tail: Promise<void> = Promise.resolve()

  async enter(): Promise<() => void> {
    let release!: () => void
    const done = new Promise<void>(resolve => (release = resolve))
    const prev = this.tail
    this.tail = prev.then(() => done)
    await prev
    return release
  }
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

// 先に始めて後で待つ処理の結果を、始めた時点で受け止める（待つまでの間に失敗しても、未処理の例外にならない）
export function capture<T>(work: Promise<T>): Promise<Settled<T>> {
  return work.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )
}
