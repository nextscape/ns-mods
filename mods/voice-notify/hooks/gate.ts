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
