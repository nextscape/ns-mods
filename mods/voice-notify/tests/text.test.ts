import { describe, expect, test } from 'claude-code/testing'

import { cleanSummary, clearSpeech, convertReading, pickSentence, stopCase } from '../hooks/text'

// config.default.json の speech.readings / lowercaseMinLength / keepUppercase と同じ値
const READING = {
  readings: {
    FIX: 'フィックス', TASK: 'タスク', DONE: 'ダン', STATUS: 'ステータス', NOTE: 'ノート', PASS: 'パス',
    FAIL: 'フェイル', TODO: 'トゥードゥー', README: 'リードミー', npm: 'エヌピーエム', pnpm: 'ピーエヌピーエム',
    npx: 'エヌピーエックス', tsc: 'ティーエスシー', json: 'ジェイソン', css: 'シーエスエス', url: 'ユーアールエル',
    cli: 'シーエルアイ', sdk: 'エスディーケー', api: 'エーピーアイ', jsx: 'ジェイエスエックス', tsx: 'ティーエスエックス',
    mcp: 'エムシーピー', llm: 'エルエルエム', utf: 'ユーティーエフ',
  },
  lowercaseMinLength: 5,
  keepUppercase: ['HTTPS', 'DPAPI'],
}

describe('text', () => {
  // 0.2.0 tests/test-sentence-rule.ps1 の 6 件（出力をそのまま期待値にした）
  test('pickSentence: a short first sentence takes the second while the two stay short', () => {
    expect(pickSentence('完了しました。テストは42件すべて通っています。')).toBe('完了しました。テストは42件すべて通っています。')
    expect(pickSentence('完了しました。認証まわりのリファクタリングを行いトークン検証を書き直しました。')).toBe(
      '完了しました。認証まわりのリファクタリングを行いトークン検証を書き直しました。',
    )
    expect(
      pickSentence('完了しました。認証まわりのリファクタリングを行い、トークンの検証処理とセッション管理を全面的に書き直したうえで統合テストも追加しています。'),
    ).toBe('完了しました。')
    expect(pickSentence('認証まわりのリファクタリングが完了し、テストは42件すべて通っています。次はデプロイです。')).toBe(
      '認証まわりのリファクタリングが完了し、テストは42件すべて通っています。',
    )
    expect(pickSentence('ビルドとテストが完了しましたのでご確認を。次に進みます。')).toBe('ビルドとテストが完了しましたのでご確認を。')
    expect(pickSentence('完了しました。')).toBe('完了しました。')
  })

  test('pickSentence: code, tables, links and URLs are not read; no sentence end takes the first 60 chars', () => {
    expect(pickSentence('```ts\nconst a = 1\n```\n詳しくは[資料](https://x.example)を見てください。')).toBe('詳しくは資料を見てください。')
    expect(pickSentence('| a | b |\n| 1 | 2 |\n表のとおりです。')).toBe('表のとおりです。')
    expect(pickSentence('abc')).toBeNull()
    expect(pickSentence('')).toBeNull()
    expect(pickSentence('句点の無い長い文'.repeat(10))).toBe(`${'句点の無い長い文'.repeat(10).slice(0, 60)}。`)
  })

  // 0.2.0 tests/test-stop-case.ps1 の 25 件
  test('stopCase: ask, trouble and done from the last two sentences', () => {
    const cases: Array<[ReturnType<typeof stopCase>, string]> = [
      ['done', 'レビューと最適化を完了し、setup.ps1の2手順で導入できるようになりました。BOMや戻り値の不具合も修正済みです。'],
      ['done', '移動後の動作確認です。新しい場所から読み上げています。'],
      ['done', '進行状況を確認しました。最初のチャンク（最大サイズのファイル群）を送信中です。'],
      ['ask', '作業フォルダがクラウド同期の対象に入っているため、音声キャッシュが同期されてオフラインで失敗します。生成物をローカルへ逃がす案ですが、配置場所はどちらにしましょうか。'],
      ['ask', 'ワークスペースの移動を確認し、実行時に壊れるハードコード3箇所を新パスへ修正しました。次のステップの番号をお選びください。'],
      ['ask', '原因のセッションを特定しました。移動により同期の問題は解消しています。履歴ごと再開するか、このまま続行するかどちらにしますか。'],
      ['ask', 'oldパスのファイル移動と外部参照の再設定が完了し、動作確認も取れました。現在稼働中のセッションがあるため旧ディレクトリの削除とコミットをどうするか、ご判断をお願いします。'],
      ['ask', '旧ワークスペースと新環境の全ファイル突合を終え、旧側はごみ箱へ移動しました。未コミットのVOICEVOXなどの扱いをどうしますか。'],
      ['ask', 'VOICEVOXを復旧し、APIとずんだもんの応答を確認しました。未pushのコミットと未コミットの変更について、どちらに対応しましょうか。'],
      ['ask', 'コミットは既に別経路でpushまで完了しており、内容は完全一致しています。サンプルのフォルダが消えていますが、原本やごみ箱にあり実害はありません。今後の対応をどちらにしましょうか。'],
      ['ask', '新リポジトリを作成し接続を完了させましたが、個人的なメモが含まれています。履歴から除外してpushするかどうか、ご判断をお願いします。'],
      ['ask', '移行が完了し、ファイル数は138件で完全一致しています。旧リポジトリの扱いなど4点について、ご判断をお願いします。'],
      ['trouble', 'テストが3件失敗しています。原因はまだ特定できていません。'],
      ['trouble', 'ビルドでエラーが出ています。状況を整理しました。'],
      ['trouble', '設定を見直しましたが、ENGINEに接続できていません。'],
      ['done', '認証エラーを修正しました。テストは42件すべて通っています。'],
      ['done', 'BOM欠落による文字化けの不具合を解消しました。動作確認も取れています。'],
      ['trouble', 'エラーを修正しましたが、まだ3件失敗しています。'],
      ['ask', 'テストが3件失敗しています。仕様の意図を確認したいので、ご判断をお願いします。'],
      ['done', '当初はエラーで停止していました。原因はパスの誤りでした。修正して全件通っています。'],
      ['ask', '対応方針は次のとおりです。| 案 | 内容 |\n| A | 即時 |\nどちらで進めますか。'],
      ['ask', 'これで実装に進んでよろしいですか。'],
      ['done', '完了しました。'],
      ['done', '1'],
      ['done', ''],
    ]
    for (const [want, text] of cases) expect([text, stopCase(text)]).toEqual([text, want])
  })

  // 0.2.0 tests/test-readings.ps1 の置き換え 17 件（ENGINE の読みの照合は実機確認で見る）
  test('convertReading: dictionary first, long all-caps words lowercased, word boundaries kept', () => {
    const cases: Array<[string, string]> = [
      ['FIXを入れました。', 'フィックスを入れました。'],
      ['fix と Fix も同じ読み。', 'フィックス と フィックス も同じ読み。'],
      ['テストは全件PASSです。', 'テストは全件パスです。'],
      ['FAILが2件、TODOが1件。', 'フェイルが2件、トゥードゥーが1件。'],
      ['READMEを更新しました。', 'リードミーを更新しました。'],
      ['npm test と tsc が通りました。', 'エヌピーエム test と ティーエスシー が通りました。'],
      ['JSONとAPIを直しました。', 'ジェイソンとエーピーアイを直しました。'],
      ['TASK 1677 は DONE です。', 'タスク 1677 は ダン です。'],
      ['Status: DONE_WITH_CONCERNS', 'ステータス: DONE_WITH_CONCERNS'],
      ['Status: DONE WITH CONCERNS', 'ステータス: ダン WITH concerns'],
      ['ADDRESSED と NARRATOR LABEL を直しました。', 'addressed と narrator label を直しました。'],
      ['HTTPS と VOICEVOX。', 'HTTPS と voicevox。'],
      ['FIXTUREとPREFIXの中のFIX。', 'fixtureとprefixの中のフィックス。'],
      ['FIX2 と PASS_1 も対象外。', 'FIX2 と PASS_1 も対象外。'],
      ['pnpm は npm と別に置き換える。', 'ピーエヌピーエム は エヌピーエム と別に置き換える。'],
      ['(FIX) / [PASS]', '(フィックス) / [パス]'],
      ['', ''],
    ]
    for (const [text, want] of cases) expect([text, convertReading(text, READING)]).toEqual([text, want])
  })

  test('clearSpeech drops markdown marks; cleanSummary drops a lead-in and keeps the first line', () => {
    expect(clearSpeech('**太字**と`code`と# 見出し')).toBe('太字 と code と 見出し')
    expect(cleanSummary('要約：直しました。\n補足です。', 60)).toEqual({ text: '直しました。' })
    expect(cleanSummary('要約:\n直しました。', 60)).toEqual({ text: '直しました。' })
    expect(cleanSummary('  \n ', 60)).toEqual({ error: 'empty-reply' })
    expect(cleanSummary('あ'.repeat(181), 60)).toEqual({ error: 'too-long (181)' })
  })
})
