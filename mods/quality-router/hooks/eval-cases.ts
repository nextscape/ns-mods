import type { Level, TurnSignals } from '../types'
import type { SubKind, Weight } from './sub-route'

// Cases for /qr eval. The first 16 main cases are from effort-router v0.3.0
// (in this marketplace); the max cases and the sub cases are new. Add real requests
// from /qr log main that were judged wrong, rewritten so they name no
// customer, project or local path (use placeholders such as 案件A): the
// cases may be sent outside Anthropic to compare another judge.

export type MainCase = { name: string; request: string; prev: TurnSignals | null; recent: Array<Level | null>; expect: Level }
export type SubCase = { name: string; type: string; description: string; prompt: string; expect: SubKind; weight: Weight }

const heavy = (request: string, answerTail: string, toolErrors = 0): TurnSignals => ({
  level: 'xhigh',
  judged: 'xhigh',
  steps: 9,
  tools: 14,
  toolErrors,
  durationMs: 210_000,
  request,
  answerTail,
})

const light = (request: string, answerTail: string): TurnSignals => ({
  level: 'medium',
  judged: 'medium',
  steps: 1,
  tools: 0,
  toolErrors: 0,
  durationMs: 6_000,
  request,
  answerTail,
})

export const MAIN_CASES: MainCase[] = [
  // From effort-router: no context, the request alone decides.
  { name: 'fresh-simple-question', request: 'TypeScript の satisfies 演算子って何をするものか一言で教えて', prev: null, recent: [], expect: 'medium' },
  { name: 'fresh-rename', request: 'utils.ts の関数 fmtDate を formatDate にリネームして', prev: null, recent: [], expect: 'high' },
  { name: 'fresh-explain-file', request: 'src/pipeline/split.ts が何をしているか説明してほしい', prev: null, recent: [], expect: 'high' },
  { name: 'fresh-design', request: 'スライド生成パイプラインにキャッシュ層を入れたい。設計案を複数出してトレードオフを比較して', prev: null, recent: [], expect: 'xhigh' },
  { name: 'fresh-debug', request: 'npm test で split.test.ts だけ落ちる。原因を調べて直して', prev: null, recent: [], expect: 'xhigh' },
  { name: 'fresh-stack-trace', request: "これが出て起動しない\n```\nTypeError: Cannot read properties of undefined (reading 'body')\n    at splitHtml (split.ts:42:13)\n    at run (pipeline.ts:88:5)\n    at main (index.ts:12:3)\n```", prev: null, recent: [], expect: 'xhigh' },
  { name: 'fresh-commit-msg', request: 'いまの差分にコミットメッセージを付けてコミットして', prev: null, recent: [], expect: 'medium' },
  // From effort-router: context makes a plain-looking request heavy.
  { name: 'ctx-pick-option-after-design', request: '案2の方向で、さっきの設計どおりに実装を進めてください', prev: heavy('キャッシュ層の設計案を比較して', '…案1はシンプルだが無効化が難しい。案2は複雑だが整合性を保てる。どちらで進めますか？'), recent: ['xhigh', 'xhigh'], expect: 'xhigh' },
  { name: 'ctx-still-broken', request: '直してもらったけど、まだ同じエラーが出ます。確認してください', prev: heavy('split.test.ts が落ちる原因を調べて', '…body 側の CSS が落ちていたのが原因でした。修正してテストが通ることを確認しました。', 2), recent: ['xhigh'], expect: 'xhigh' },
  { name: 'ctx-continue-steps', request: 'その調子で残りのステップ3から5もお願いします', prev: heavy('移行計画の実装をステップ1から', '…ステップ1と2を実装し、テストも通りました。残りはステップ3〜5です。'), recent: ['xhigh', 'xhigh', 'xhigh'], expect: 'xhigh' },
  // From effort-router: context makes a request light even after heavy work.
  { name: 'ctx-thanks-after-heavy', request: 'ありがとうございます、助かりました。今日はここまでにします', prev: heavy('原因調査', '…修正してテストが通りました。'), recent: ['xhigh'], expect: 'medium' },
  { name: 'ctx-typo-after-heavy', request: 'README の「インストール」の誤字だけ直しておいて', prev: heavy('設計レビュー', '…以上がレビュー結果です。'), recent: ['xhigh'], expect: 'medium' },
  { name: 'ctx-yesno-confirm', request: 'さっきの変更はもう push 済みという認識で合ってる？', prev: light('main に push して', '…push しました。'), recent: ['medium'], expect: 'medium' },
  // From effort-router: context keeps an ordinary task ordinary.
  { name: 'ctx-add-test-after-light', request: 'formatDate にうるう年のテストケースを1つ追加して', prev: light('fmtDate をリネームして', '…リネームしました。'), recent: ['high', 'medium'], expect: 'high' },
  { name: 'ctx-review-after-light', request: '今の差分をレビューして、問題があれば指摘して', prev: light('コミットして', '…コミットしました。'), recent: ['medium'], expect: 'high' },
  { name: 'ctx-new-topic-heavy-after-light', request: '話は変わるけど、認証まわりを JWT からセッション方式に移行したい。影響範囲を洗い出して計画を立てて', prev: light('typo を直して', '…直しました。'), recent: ['medium'], expect: 'xhigh' },
  // New: max.
  { name: 'max-fix-failed-again', request: '修正してもらったのに、まだ同じテストが落ちます。これで3回目です。根本原因から洗い直してください', prev: heavy('split.test.ts を直して', '…修正しました。テストが通ることを確認しました。', 2), recent: ['xhigh', 'xhigh'], expect: 'max' },
  { name: 'max-irreversible-migration', request: '本番DBのスキーマ移行の方針を決めたい。ロールバックできない変更なので、リスクを徹底的に洗い出して', prev: null, recent: [], expect: 'max' },
  { name: 'max-explicit-deepest', request: 'この設計判断は後戻りできません。考えうる最も深いレベルで分析してください。時間はかかって構いません', prev: null, recent: [], expect: 'max' },
  { name: 'max-prod-incident', request: '本番で決済が二重に計上されている。直前の修正では直らなかった。原因を特定して', prev: heavy('決済の重複を直して', '…冪等キーを追加しました。', 1), recent: ['xhigh'], expect: 'max' },
  // New: discussion, planning and quick status.
  { name: 'xhigh-pick-with-condition', request: '案Bでいきましょう。ただしロールバック手順も設計に含めてください', prev: heavy('移行方式の案を比べて', '…案Aは早いが戻せない。案Bは段階的に戻せる。どちらにしますか？'), recent: ['xhigh'], expect: 'xhigh' },
  { name: 'xhigh-review-plan', request: 'この実装計画をレビューして、抜け漏れや危ない作業順がないか指摘して', prev: null, recent: [], expect: 'xhigh' },
  { name: 'high-explain-config', request: 'tsconfig の strict と noUncheckedIndexedAccess の違いを説明して', prev: null, recent: [], expect: 'high' },
  { name: 'medium-status-one-line', request: 'いまどこまで進んだか、一言で教えてもらえますか', prev: heavy('実装を進めて', '…タスク3まで終わりました。'), recent: ['xhigh'], expect: 'medium' },
]

export const SUB_CASES: SubCase[] = [
  { name: 'chore-list', type: 'general-purpose', description: 'list hook files', prompt: 'プロジェクトの .claude/hooks フォルダのファイル名を一覧にして返して', expect: 'chore', weight: 'light' },
  { name: 'chore-count', type: 'general-purpose', description: 'count commands', prompt: '.claude/commands のファイル数を数えて数字だけ返して', expect: 'chore', weight: 'light' },
  { name: 'chore-commit', type: 'general-purpose', description: 'commit typo fix', prompt: 'いまの差分をコミットして。メッセージは「fix: 誤字を修正」で', expect: 'chore', weight: 'light' },
  { name: 'impl-rename', type: 'general-purpose', description: 'rename function', prompt: 'utils.ts の関数 fmtDate を formatDate にリネームして、呼び出し元も直して', expect: 'impl', weight: 'light' },
  { name: 'impl-lexer', type: 'general-purpose', description: 'implement parser', prompt: 'gate-lexer.ts に正規表現リテラルの読み飛ばしを実装して、テストも足して', expect: 'impl', weight: 'heavy' },
  { name: 'impl-auth', type: 'general-purpose', description: 'implement session auth', prompt: '認証をセッション方式に切り替える実装を、設計メモに沿って複数のファイルにわたって進めて', expect: 'impl', weight: 'heavy' },
  { name: 'investigate-api', type: 'general-purpose', description: 'research API', prompt: 'Azure DevOps の PR スレッド API でコメントを解決済みにする方法を調べて、公式ドキュメントの根拠つきで報告して', expect: 'investigate', weight: 'light' },
  { name: 'investigate-failing', type: 'general-purpose', description: 'investigate failing test', prompt: 'npm test で register.test.ts だけ落ちる原因を調べて、原因と根拠を報告して', expect: 'investigate', weight: 'heavy' },
  { name: 'investigate-status', type: 'general-purpose', description: 'sprint status', prompt: '案件A の今週の Sprint の進捗を調べて、遅れているチケットと理由をまとめて報告して', expect: 'investigate', weight: 'light' },
  { name: 'verify-tests', type: 'general-purpose', description: 'run tests', prompt: 'テストを実行して、全部通ったかどうかと失敗したテスト名だけを返して', expect: 'verify', weight: 'light' },
  { name: 'verify-build', type: 'general-purpose', description: 'check build', prompt: 'ビルドが通るか確かめて、エラーがあれば最初の5行を返して', expect: 'verify', weight: 'light' },
  { name: 'verify-report', type: 'general-purpose', description: 'verify report', prompt: '次の調査報告に書かれた固有名詞とタイムスタンプを実 API で照合し、誤りがあれば指摘して', expect: 'verify', weight: 'heavy' },
  { name: 'review-small', type: 'general-purpose', description: 'review small diff', prompt: 'この10行の差分をレビューして、明らかな誤りがあれば指摘して', expect: 'review', weight: 'light' },
  { name: 'review-diff', type: 'general-purpose', description: 'review diff', prompt: 'この差分をレビューして、正しさのバグと抜けているテストを指摘して', expect: 'review', weight: 'heavy' },
  { name: 'review-design', type: 'general-purpose', description: 'review design coverage', prompt: '設計書の決定事項がすべて実装に反映されているかレビューし、抜けと矛盾を列挙して', expect: 'review', weight: 'heavy' },
  { name: 'refute-cache', type: 'general-purpose', description: 'refute finding', prompt: 'この指摘「キャッシュが無効になる」を反証して。反証できなければ refuted=false と答えて', expect: 'refute', weight: 'heavy' },
  { name: 'refute-cause', type: 'general-purpose', description: 'refute root cause', prompt: '「この不具合の原因は設定ファイルの誤り」という結論の反例を探して崩してみて', expect: 'refute', weight: 'heavy' },
  { name: 'refute-claim', type: 'general-purpose', description: 'refute simple claim', prompt: '「この関数は常に正の数を返す」という主張が明らかに誤っていないかだけ確かめて', expect: 'refute', weight: 'light' },
  { name: 'decide-merge', type: 'general-purpose', description: 'merge decision', prompt: 'レビュー結果を読んで、マージしてよいかを yes か no で答えて', expect: 'decide', weight: 'light' },
  { name: 'decide-migration', type: 'general-purpose', description: 'choose migration', prompt: '移行方式の案A と案B を比べ、どちらで進めるべきか理由とともに決めて', expect: 'decide', weight: 'heavy' },
  { name: 'decide-audit', type: 'general-purpose', description: 'audit verdict', prompt: '実装計画が仕様のすべての要件を満たしているか監査して、合格か不合格かを決めて', expect: 'decide', weight: 'heavy' },
]
