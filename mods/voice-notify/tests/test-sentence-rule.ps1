# 文抽出ルールの検証（notify.ps1 の Pick-Sentence を読み込んで実行する）
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cfg = Get-Content (Join-Path (Split-Path -Parent $Here) "config.default.json") -Raw -Encoding UTF8 | ConvertFrom-Json

# notify.ps1 から Pick-Sentence の定義だけを取り出して読み込む
$src = Get-Content (Join-Path (Split-Path -Parent $Here) "scripts\notify.ps1") -Raw
$m = [regex]::Match($src, '(?s)function Pick-Sentence.*?\n\}')
if (-not $m.Success) { throw "Pick-Sentence が見つかりません" }
Invoke-Expression $m.Value

"閾値: 先頭1文 <= $($Cfg.speech.shortSentenceChars)字 なら2文目まで / 合計 <= $($Cfg.speech.maxTwoSentenceChars)字 まで"
""

$cases = @(
  @{ n = "7字 + 17字 = 24字";  t = "完了しました。テストは42件すべて通っています。" },
  @{ n = "7字 + 45字 = 52字";  t = "完了しました。認証まわりのリファクタリングを行いトークン検証を書き直しました。" },
  @{ n = "7字 + 62字 = 69字";  t = "完了しました。認証まわりのリファクタリングを行い、トークンの検証処理とセッション管理を全面的に書き直したうえで統合テストも追加しています。" },
  @{ n = "36字の1文目";         t = "認証まわりのリファクタリングが完了し、テストは42件すべて通っています。次はデプロイです。" },
  @{ n = "21字の1文目";         t = "ビルドとテストが完了しましたのでご確認を。次に進みます。" },
  @{ n = "1文のみ";             t = "完了しました。" }
)

foreach ($c in $cases) {
  $r = Pick-Sentence $c.t
  $n = ([regex]::Matches($r, '[^。！？!?]+[。！？!?]')).Count
  "{0,-20} -> [{1,2}字/{2}文] {3}" -f $c.n, $r.Length, $n, $r
}
