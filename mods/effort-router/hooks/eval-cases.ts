import type { Level, Option, TurnSignals } from '../types'
import type { Asked } from './route'

// Cases for `/effort-router eval`: the classifier's judgment against the
// level a person would pick for Claude Opus 5.5. Edit freely.

export type EvalCase = {
  name: string
  request: string
  prev: TurnSignals | null
  recent: Array<Level | null>
  expect: Level
  // An AskUserQuestion answer mid-turn: `prev` is the turn so far and
  // `request` only names the case.
  asked?: Asked
}

const ask = (question: string, header: string, options: Array<[string, string]>, answer: string): Asked => ({
  questions: [{ question, header, options: options.map(([label, description]) => ({ label, description })), multiSelect: false }],
  answers: { [question]: answer },
})

const NEXT_STEP: Array<[string, string]> = [
  ['実装する', 'キャッシュ層を追加し、pipeline と split と index の3ファイルを変更する'],
  ['コミットして終了', 'ここまでの差分をコミットして今日は終わる'],
]

const heavy = (request: string, answerTail: string, toolErrors = 0, options: Option[] = []): TurnSignals => ({
  level: 'xhigh',
  steps: 9,
  tools: 14,
  toolErrors,
  durationMs: 210_000,
  request,
  answerTail,
  options,
  asks: options.length > 0 || /[?？]/.test(answerTail),
})

const light = (request: string, answerTail: string, options: Option[] = []): TurnSignals => ({
  level: 'medium',
  steps: 1,
  tools: 0,
  toolErrors: 0,
  durationMs: 6_000,
  request,
  answerTail,
  options,
  asks: options.length > 0 || /[?？]/.test(answerTail),
})

const choices = (...texts: string[]): Option[] => texts.map((text, i) => ({ key: String(i + 1), text }))

const AFTER_DESIGN = choices(
  '案2で実装を進める（キャッシュ層を追加し、pipeline と split と index の3ファイルを変更）',
  '設計の前提をもう一度洗い出して比較し直す',
  'ここまでの設計メモをコミットして今日は終了',
)
const AFTER_TYPO = choices(
  'README の誤字だけ直して終わる',
  'formatDate にうるう年のテストを1件追加する',
  '認証まわりを JWT からセッション方式へ移す影響範囲を洗い出して移行計画を立てる',
)

export const CASES: EvalCase[] = [
  // No context: the request alone decides.
  { name: 'fresh-simple-question', request: 'TypeScript の satisfies 演算子って何をするものか一言で教えて', prev: null, recent: [], expect: 'low' },
  { name: 'fresh-rename', request: 'utils.ts の関数 fmtDate を formatDate にリネームして', prev: null, recent: [], expect: 'low' },
  { name: 'fresh-commit-msg', request: 'いまの差分にコミットメッセージを付けてコミットして', prev: null, recent: [], expect: 'low' },
  { name: 'fresh-wording-everywhere', request: '全ページのヘッダーにある「問い合わせ」の表記を「お問い合わせ」にそろえて', prev: null, recent: [], expect: 'low' },
  { name: 'fresh-explain-file', request: 'src/pipeline/split.ts が何をしているか説明してほしい', prev: null, recent: [], expect: 'medium' },
  { name: 'fresh-implement-settled', request: 'さっき決めた仕様どおり、CSV エクスポートのボタンと API を追加して。テストも書いて', prev: null, recent: [], expect: 'medium' },
  { name: 'fresh-design', request: 'スライド生成パイプラインにキャッシュ層を入れたい。設計案を複数出してトレードオフを比較して', prev: null, recent: [], expect: 'high' },
  { name: 'fresh-debug', request: 'npm test で split.test.ts だけ落ちる。原因を調べて直して', prev: null, recent: [], expect: 'high' },
  { name: 'fresh-stack-trace', request: 'これが出て起動しない\n```\nTypeError: Cannot read properties of undefined (reading \'body\')\n    at splitHtml (split.ts:42:13)\n    at run (pipeline.ts:88:5)\n    at main (index.ts:12:3)\n```', prev: null, recent: [], expect: 'high' },
  { name: 'fresh-codebase-review', request: 'このリポジトリ全体をレビューして、バグや考慮漏れを洗い出して', prev: null, recent: [], expect: 'xhigh' },
  { name: 'fresh-find-all', request: 'プロジェクト全体で旧 API の fetchUser を呼んでいる箇所を全部洗い出して、置き換えの方針を出して', prev: null, recent: [], expect: 'xhigh' },
  { name: 'fresh-fundamental', request: '場当たり的な修正が続いて同じ種類の不具合が何度も出ている。根本的な解決策を検討して', prev: null, recent: [], expect: 'xhigh' },
  { name: 'fresh-data-migration', request: '本番 DB の users テーブルを分割するマイグレーションを書いて。データは消せない', prev: null, recent: [], expect: 'xhigh' },

  // Context makes a plain-looking request heavy, or keeps it ordinary.
  { name: 'ctx-pick-option-after-design', request: '案2の方向で、さっきの設計どおりに実装を進めてください', prev: heavy('キャッシュ層の設計案を比較して', '…案1はシンプルだが無効化が難しい。案2は複雑だが整合性を保てる。どちらで進めますか？'), recent: ['xhigh', 'xhigh'], expect: 'medium' },
  { name: 'ctx-still-broken', request: '直してもらったけど、まだ同じエラーが出ます。確認してください', prev: heavy('split.test.ts が落ちる原因を調べて', '…body 側の CSS が落ちていたのが原因でした。修正してテストが通ることを確認しました。', 2), recent: ['xhigh'], expect: 'xhigh' },
  { name: 'ctx-continue-steps', request: 'その調子で残りのステップ3から5もお願いします', prev: heavy('移行計画の実装をステップ1から', '…ステップ1と2を実装し、テストも通りました。残りはステップ3〜5です。'), recent: ['xhigh', 'xhigh', 'xhigh'], expect: 'medium' },
  { name: 'ctx-new-topic-heavy-after-light', request: '話は変わるけど、認証まわりを JWT からセッション方式に移行したい。影響範囲を洗い出して計画を立てて', prev: light('typo を直して', '…直しました。'), recent: ['medium'], expect: 'xhigh' },

  // Context makes a request light even after heavy work.
  { name: 'ctx-thanks-after-heavy', request: 'ありがとうございます、助かりました。今日はここまでにします', prev: heavy('原因調査', '…修正してテストが通りました。'), recent: ['xhigh'], expect: 'low' },
  { name: 'ctx-typo-after-heavy', request: 'README の「インストール」の誤字だけ直しておいて', prev: heavy('設計レビュー', '…以上がレビュー結果です。'), recent: ['xhigh'], expect: 'low' },
  { name: 'ctx-yesno-confirm', request: 'さっきの変更はもう push 済みという認識で合ってる？', prev: light('main に push して', '…push しました。'), recent: ['medium'], expect: 'low' },
  { name: 'ctx-add-test-after-light', request: 'formatDate にうるう年のテストケースを1つ追加して', prev: light('fmtDate をリネームして', '…リネームしました。'), recent: ['high', 'medium'], expect: 'medium' },
  { name: 'ctx-review-after-light', request: '今の差分をレビューして、問題があれば指摘して', prev: light('コミットして', '…コミットしました。'), recent: ['medium'], expect: 'high' },

  // A number picks an offered option: its text decides, not the turn before.
  { name: 'choice-low-after-design', request: '3', prev: heavy('キャッシュ層の設計案を比較して', '…1〜3から選んでください。', 0, AFTER_DESIGN), recent: ['xhigh', 'xhigh'], expect: 'low' },
  { name: 'choice-medium-after-design', request: '1でお願いします', prev: heavy('キャッシュ層の設計案を比較して', '…1〜3から選んでください。', 0, AFTER_DESIGN), recent: ['xhigh'], expect: 'medium' },
  { name: 'choice-xhigh-after-light', request: '3で', prev: light('typo を直して', '…直しました。次はどうしますか？', AFTER_TYPO), recent: ['medium'], expect: 'xhigh' },
  { name: 'choice-medium-after-light', request: '2番', prev: light('typo を直して', '…直しました。次はどうしますか？', AFTER_TYPO), recent: ['medium'], expect: 'medium' },

  // A short reply agrees to what the previous answer proposed.
  { name: 'reply-yes-to-investigation', request: 'はい', prev: light('テストを流して', '…split.test.ts だけが落ちています。原因を調査して修正まで進めますか？'), recent: ['medium'], expect: 'high' },
  { name: 'reply-ok-to-design', request: 'ＯＫ', prev: light('macOS と Linux にも対応させたい', '…かなり大きな作り直しになります。進めるなら、まず仕様の詰めから始め、設計文書にしてから実装に入りたいと思います。それでよいですか？'), recent: ['medium'], expect: 'high' },
  { name: 'reply-ok-to-commit', request: 'OK', prev: heavy('原因を調べて直して', '…修正してテストが通りました。この内容でコミットしますか？'), recent: ['xhigh'], expect: 'low' },
  { name: 'reply-ok-beside-list', request: 'OK', prev: light('fetchUser の置き換え方針をまとめて', '…1. 型定義の更新 2. API 層の差し替え 3. プロジェクト全体の呼び出し元の置き換え。この順で全体の移行作業に入りますか？', choices('型定義の更新', 'API 層の差し替え', 'プロジェクト全体の呼び出し元の置き換え')), recent: ['medium'], expect: 'xhigh' },

  // A short prompt that names its own work, or declines, is judged as a request.
  { name: 'short-audit-after-light', request: 'リポジトリ全体を監査して', prev: light('typo を直して', '…直しました。'), recent: ['medium'], expect: 'xhigh' },
  { name: 'short-cause-after-question', request: '落ちる原因を調べて', prev: light('テストを流して', '…split.test.ts だけが落ちています。ほかは通ったのでコミットしますか？'), recent: ['medium'], expect: 'high' },
  { name: 'short-decline-after-proposal', request: 'いや、やめておいて', prev: heavy('原因を調べて直して', '…根本的に直すなら設計の見直しが必要です。進めますか？'), recent: ['xhigh'], expect: 'low' },

  // An AskUserQuestion answer mid-turn: the picked option's meaning decides.
  { name: 'asked-commit-in-heavy-turn', request: '(AskUserQuestion)', asked: ask('次にどう進めますか？', '進め方', NEXT_STEP, 'コミットして終了'), prev: heavy('キャッシュ層の設計案を比較して', ''), recent: ['xhigh'], expect: 'low' },
  { name: 'asked-implement-in-light-turn', request: '(AskUserQuestion)', asked: ask('次にどう進めますか？', '進め方', NEXT_STEP, '実装する'), prev: light('キャッシュ層の案を一言で', ''), recent: ['medium'], expect: 'medium' },
  { name: 'asked-typed-investigate', request: '(AskUserQuestion)', asked: ask('次にどう進めますか？', '進め方', NEXT_STEP, 'その前に split.test.ts が落ちる原因を調べて'), prev: light('テストを流して', ''), recent: ['medium'], expect: 'high' },
]
