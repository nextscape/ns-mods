// Letting async work through one at a time within a session (no $ here).
// Calling the function enter() resolves to lets the next one through.
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

// Holds the outcome of work started now and awaited later, so a failure in
// between is not an unhandled rejection.
export function capture<T>(work: Promise<T>): Promise<Settled<T>> {
  return work.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )
}
