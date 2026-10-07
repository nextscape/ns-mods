import type { Top } from '../types'
import { ladder } from './levels'

// The section prompt.compose adds while the gate is on. English,
// because the main loop is its reader.
export function guidanceText(top: Top): string {
  const rungs = ladder(top)
    .map((rung, i) => `  { model: '${rung.model}', effort: '${rung.effort}' }, // ${i}`)
    .join('\n')
  return [
    '# quality-router: staffing Workflow agents',
    'Every agent() call in a Workflow script carries a label that starts with its kind, and a weight the gate can read: effort as a string, or ...LADDER[n] with a numeric n. quality-router reads the script when Workflow is called and sends it back when a rule is broken.',
    "Write the options of each agent() call inline as an object literal, with the label as a string or template literal whose kind prefix comes before any ${…}: options held in a variable cannot be checked and are sent back, and so is any spread but ...LADDER[n]. Write either model and effort or a rung: when both are written, the gate checks whichever could win.",
    'Strength compares the model tier first (haiku < sonnet < top: opus or fable), then effort. Omitting model inherits the session model, which counts as the top tier.',
    "- chore: mechanical work (listing, counting, collecting, formatting, committing). From haiku·low up to sonnet·medium, e.g. ...LADDER[1]. Leaving model out inherits the top tier and is sent back.",
    '- impl: implementing and fixing. At least sonnet·medium; heavier work on the top model.',
    '- investigate: research, root-cause analysis, reports someone relies on. At least sonnet·medium.',
    '- verify: checks with mechanical evidence (running tests or builds, matching facts against a source). At least sonnet·high.',
    '- review: judging whether a diff or design is good. At least the top model at high.',
    '- refute: trying to break a conclusion. At least the top model at high.',
    '- decide: choosing a direction or a pass/fail verdict. At least the top model at high.',
    "- fix: a redo after a quality failure. Move at least one rung up with ...LADDER[tier + 1] (only fix: may use an expression index) and pass the reviewer's findings verbatim.",
    'Mechanical failures (timeout, API error, malformed output) retry on the same rung.',
    'After two escalations without a pass, end the workflow and hand the decision back to the user.',
    'Declare the ladder in the script exactly as:',
    'const LADDER = [',
    rungs,
    ']',
  ].join('\n')
}
