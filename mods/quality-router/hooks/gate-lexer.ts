// Reads a Workflow script token by token and finds its agent( ... ) calls.
// Strings, template literals, comments and regex literals are skipped, so a
// description that mentions "agent()" is not a call (the spike's false hit).

export type Token = {
  kind: 'ident' | 'punct' | 'string' | 'template' | 'regex' | 'number'
  text: string
  start: number
  end: number
}

export type OptionsInfo =
  | { kind: 'none' }
  | { kind: 'dynamic'; text: string }
  | { kind: 'object'; entries: Record<string, Token[]>; spreads: string[] }

export type AgentCall = { ordinal: number; options: OptionsInfo }

const REGEX_AFTER_PUNCT = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>',
])
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'await', 'yield',
])
// A ')' that closes `if (`, `while (`, `for (` or `with (` ends a statement head, so a '/' after it starts a regex.
const STATEMENT_HEAD = new Set(['if', 'while', 'for', 'with'])
const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])

function skipQuoted(src: string, i: number, quote: string): number {
  i += 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    i += 1
    if (c === quote || c === '\n') break
  }
  return i
}

// From just after `${` to just after its closing `}`.
function skipExpression(src: string, i: number): number {
  let depth = 1
  while (i < src.length && depth > 0) {
    const c = src[i]
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i, c)
      continue
    }
    if (c === '`') {
      i = skipTemplate(src, i)
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    i += 1
  }
  return i
}

function skipTemplate(src: string, i: number): number {
  i += 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') return i + 1
    if (c === '$' && src[i + 1] === '{') {
      i = skipExpression(src, i + 2)
      continue
    }
    i += 1
  }
  return i
}

function skipRegex(src: string, i: number): number {
  i += 1
  let inClass = false
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '\n') break
    i += 1
    if (inClass) {
      if (c === ']') inClass = false
    } else if (c === '[') {
      inClass = true
    } else if (c === '/') {
      while (i < src.length && /[a-z]/i.test(src[i] ?? '')) i += 1
      break
    }
  }
  return i
}

export function tokenize(src: string): Token[] {
  const out: Token[] = []
  const push = (kind: Token['kind'], start: number, end: number) =>
    out.push({ kind, text: src.slice(start, end), start, end })
  // One entry per open '(': whether it follows a STATEMENT_HEAD word.
  const parens: boolean[] = []
  // Indexes in `out` of the ')' tokens that close a statement head.
  const headCloses = new Set<number>()
  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2)
      i = j < 0 ? src.length : j + 2
      continue
    }
    const start = i
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i, c)
      push('string', start, i)
      continue
    }
    if (c === '`') {
      i = skipTemplate(src, i)
      push('template', start, i)
      continue
    }
    if (c === '/') {
      const prev = out[out.length - 1]
      const isRegex =
        prev === undefined ||
        (prev.kind === 'punct' && REGEX_AFTER_PUNCT.has(prev.text)) ||
        (prev.kind === 'punct' && prev.text === ')' && headCloses.has(out.length - 1)) ||
        (prev.kind === 'ident' && REGEX_AFTER_WORD.has(prev.text))
      if (isRegex) {
        i = skipRegex(src, i)
        push('regex', start, i)
        continue
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      while (i < src.length && /[\w$]/.test(src[i] ?? '')) i += 1
      push('ident', start, i)
      continue
    }
    if (/[0-9]/.test(c)) {
      while (i < src.length && /[\w.]/.test(src[i] ?? '')) i += 1
      push('number', start, i)
      continue
    }
    const three = src.slice(i, i + 3)
    const two = src.slice(i, i + 2)
    // `++` and `--` are one token and not in REGEX_AFTER_PUNCT, so `i++ / 2` reads as a division.
    const text = three === '...' ? three : two === '=>' || two === '?.' || two === '++' || two === '--' ? two : c
    i += text.length
    if (text === '(') {
      const prev = out[out.length - 1]
      parens.push(prev?.kind === 'ident' && STATEMENT_HEAD.has(prev.text))
    } else if (text === ')' && parens.pop()) {
      headCloses.add(out.length)
    }
    push('punct', start, i)
  }
  return out
}

// From the '(' at `open`: the index of its matching ')' (toks.length when it is never closed).
function closeOf(toks: Token[], open: number): number {
  let depth = 0
  for (let j = open; j < toks.length; j += 1) {
    const t = toks[j]!
    if (t.kind !== 'punct') continue
    if (OPEN.has(t.text)) depth += 1
    else if (CLOSE.has(t.text)) {
      depth -= 1
      if (depth === 0) return j
    }
  }
  return toks.length
}

// From the '(' at `open`: each top-level argument's tokens.
function splitArgs(toks: Token[], open: number): Token[][] {
  const args: Token[][] = [[]]
  let depth = 0
  for (let j = open; j < toks.length; j += 1) {
    const t = toks[j]!
    if (t.kind === 'punct' && OPEN.has(t.text)) {
      depth += 1
      if (depth === 1) continue
    } else if (t.kind === 'punct' && CLOSE.has(t.text)) {
      depth -= 1
      if (depth === 0) break
    } else if (depth === 1 && t.kind === 'punct' && t.text === ',') {
      args.push([])
      continue
    }
    args[args.length - 1]!.push(t)
  }
  return args.filter(arg => arg.length > 0)
}

function keyName(t: Token): string | null {
  if (t.kind === 'ident') return t.text
  if (t.kind === 'string') return t.text.slice(1, -1)
  return null
}

function optionsOf(src: string, arg: Token[] | undefined): OptionsInfo {
  if (!arg || arg.length === 0) return { kind: 'none' }
  const first = arg[0]!
  const last = arg[arg.length - 1]!
  const isObject = first.kind === 'punct' && first.text === '{' && last.kind === 'punct' && last.text === '}'
  if (!isObject) return { kind: 'dynamic', text: src.slice(first.start, last.end) }

  const entries: Record<string, Token[]> = {}
  const spreads: string[] = []
  let depth = 0
  let entry: Token[] = []
  const flush = () => {
    const lead = entry[0]
    if (lead === undefined) return
    if (lead.kind === 'punct' && lead.text === '...') {
      const rest = entry.slice(1)
      const a = rest[0]
      const b = rest[rest.length - 1]
      if (a && b) spreads.push(src.slice(a.start, b.end))
    } else {
      const key = keyName(lead)
      const colon = entry[1]
      if (key !== null && colon?.kind === 'punct' && colon.text === ':') entries[key] = entry.slice(2)
      else if (key !== null && entry.length === 1) entries[key] = [lead]
    }
    entry = []
  }
  for (const t of arg.slice(1, -1)) {
    if (t.kind === 'punct' && OPEN.has(t.text)) depth += 1
    else if (t.kind === 'punct' && CLOSE.has(t.text)) depth -= 1
    if (depth === 0 && t.kind === 'punct' && t.text === ',') {
      flush()
      continue
    }
    entry.push(t)
  }
  flush()
  return { kind: 'object', entries, spreads }
}

export function scanAgentCalls(src: string): AgentCall[] {
  const toks = tokenize(src)
  const calls: AgentCall[] = []
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!
    const before = toks[i - 1]
    const after = toks[i + 1]
    if (t.kind !== 'ident' || t.text !== 'agent') continue
    if (after?.kind !== 'punct' || after.text !== '(') continue
    if (before?.kind === 'punct' && (before.text === '.' || before.text === '?.')) continue
    if (before?.kind === 'ident' && before.text === 'function') continue
    // `agent(p) { ... }` is a method named agent (object or class shorthand, `function* agent`), not a call.
    // A real call is followed by '{' only across ASI (`agent(x)` then a block on the next line), which
    // Workflow scripts do not write; skipping it errs on the side of letting the script run.
    const next = toks[closeOf(toks, i + 1) + 1]
    if (next?.kind === 'punct' && next.text === '{') continue
    const args = splitArgs(toks, i + 1)
    calls.push({ ordinal: calls.length + 1, options: optionsOf(src, args[1]) })
  }
  return calls
}
