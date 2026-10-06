<#
英単語の読み替え（speech.readings）の検証。

  .\test-readings.ps1

notify.ps1 の Convert-Reading を読み込み、置き換え結果を確かめる。
VOICEVOX ENGINE が動いていれば、置き換え後の文を audio_query に通して
実際の読み（カナ）が期待どおりかも確かめる。
#>
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cfg  = Get-Content (Join-Path (Split-Path -Parent $Here) "config.default.json") -Raw -Encoding UTF8 | ConvertFrom-Json

# notify.ps1 から Convert-Reading の定義だけを取り出して読み込む
$src = Get-Content (Join-Path (Split-Path -Parent $Here) "scripts\notify.ps1") -Raw -Encoding UTF8
$m = [regex]::Match($src, '(?s)function Convert-Reading.*?\n\}')
if (-not $m.Success) { throw "Convert-Reading が見つかりません" }
Invoke-Expression $m.Value

# k = ENGINE で実際の読みも確かめるときの期待（アクセント記号を除いたカナへの正規表現）
$cases = @(
  @{ t = "FIXを入れました。";          e = "フィックスを入れました。";              k = '^フィックスオ' },
  @{ t = "fix と Fix も同じ読み。";     e = "フィックス と フィックス も同じ読み。"; k = '^フィックス.*フィックス' },
  @{ t = "テストは全件PASSです。";      e = "テストは全件パスです。";                k = 'ゼンケンパス' },
  @{ t = "FAILが2件、TODOが1件。";      e = "フェイルが2件、トゥードゥーが1件。";    k = 'フェエル.*トゥウドゥウ' },
  @{ t = "READMEを更新しました。";      e = "リードミーを更新しました。";            k = '^リイドミイ' },
  # 0.24 以降は小文字の略語を単語として読む（npm → ンプ、json → ジェイエスオン）
  @{ t = "npm test と tsc が通りました。"; e = "エヌピーエム test と ティーエスシー が通りました。"; k = '^エヌピイエム.*ティイエスシイ' },
  @{ t = "JSONとAPIを直しました。";     e = "ジェイソンとエーピーアイを直しました。"; k = '^ジェイソン.*エエピイアイ' },
  # 全部大文字の語（0.25.2 でも1文字ずつ読まれる）。4文字以下は辞書で直す
  @{ t = "TASK 1677 は DONE です。";     e = "タスク 1677 は ダン です。"; k = '^タスク.*ダンデス' },
  # 識別子（_ でつながった語）は触らない。読み上げ前の掃除で _ は空白になるので、実際は下の形で届く
  @{ t = "Status: DONE_WITH_CONCERNS";  e = "ステータス: DONE_WITH_CONCERNS" },
  @{ t = "Status: DONE WITH CONCERNS";  e = "ステータス: ダン WITH concerns"; k = '^ステエタスダンウィズコンサアンズ' },
  # 5文字以上の全部大文字の語は小文字にして英単語として読ませる。略語は keepUppercase で残す
  @{ t = "ADDRESSED と NARRATOR LABEL を直しました。"; e = "addressed と narrator label を直しました。"; k = '^アドレスドトナレエタアラベル' },
  @{ t = "HTTPS と VOICEVOX。";          e = "HTTPS と voicevox。"; k = '^エイチティイティイピイエス.*ボイスボックス' },
  # 語の一部には当てない
  #   FIXTURE の中の FIX は辞書で置き換えず、語全体を小文字にして読ませる
  @{ t = "FIXTUREとPREFIXの中のFIX。";  e = "fixtureとprefixの中のフィックス。"; k = '^フィクスチャアト.*フィックス' },
  @{ t = "FIX2 と PASS_1 も対象外。";   e = "FIX2 と PASS_1 も対象外。" },
  @{ t = "pnpm は npm と別に置き換える。"; e = "ピーエヌピーエム は エヌピーエム と別に置き換える。" },
  # 記号に挟まれていれば当てる
  @{ t = "(FIX) / [PASS]";             e = "(フィックス) / [パス]" },
  @{ t = "";                           e = "" }
)

$ng = 0
foreach ($c in $cases) {
  $r = Convert-Reading $c.t
  $mark = "ok  "
  if ($r -cne $c.e) { $mark = "NG  "; $ng++ }   # -ne は大文字小文字を区別しない
  "{0}{1}  →  {2}" -f $mark, $c.t, $r
}

# ENGINE があれば実際の読みも見る
$vv = "http://127.0.0.1:$($Cfg.enginePort)"
$ver = $null
try { $ver = Invoke-RestMethod "$vv/version" -TimeoutSec 2 } catch { }
""
if ($ver) {
  function Get-Kana([string]$text) {
    $r = Invoke-WebRequest -Method Post -TimeoutSec 20 -UseBasicParsing `
           -Uri ("{0}/audio_query?text={1}&speaker=3" -f $vv, [uri]::EscapeDataString($text))
    # 応答に charset が無く、PowerShell 5.1 は Latin-1 として化かす。化けたままだと
    # 照合が素通りするので、バイト列から UTF-8 で読み直す。
    $kana = ([Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json).kana
    # アクセント（'）・句の区切り（/）・無声化（_）・読点は照合の邪魔なので落とす
    $kana -replace "['/_、]", ''
  }
  "ENGINE $ver"
  # 照合そのものが効いていること（置き換え前の全部大文字は1文字読みになる）
  $raw = Get-Kana "FIXを入れました。"
  $mark = "ok  "
  if ($raw -notmatch 'エフアイエックス') { $mark = "NG  "; $ng++ }
  "{0}置き換え前の読み（1文字読みになるはず）: {1}" -f $mark, $raw
  foreach ($c in $cases | Where-Object { $_.k }) {
    $kana = Get-Kana (Convert-Reading $c.t)
    $mark = "ok  "
    if ($kana -notmatch $c.k) { $mark = "NG  "; $ng++ }
    "{0}読み: {1}" -f $mark, $kana
  }
} else {
  "ENGINE が動いていないため、実際の読みの確認は省略"
}

""
if ($ng -eq 0) { "合格" } else { "{0} 件 不合格" -f $ng; exit 1 }
