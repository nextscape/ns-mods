#!/bin/sh
# voice-notify の再生（macOS・Linux）。mod（hooks/register.ts）が呼ぶ。
#   play.sh <ロック用のディレクトリ> <再生コマンド> <wav>
# 別のセッションの再生と重なると聞き取れないので、mkdir で作れた側だけが鳴らす（mkdir は同時に呼んでも1つしか成功しない）。
# 20秒待っても空かなければ重ねて鳴らす。1分を超えて残ったロックは、落ちたプロセスの残りとみなして消す。
lock=$1
player=$2
wav=$3
held=0
i=0
while [ "$i" -lt 200 ]; do
  if mkdir "$lock" 2>/dev/null; then held=1; break; fi
  # 古いロックは消して、すぐ取り直す（確かめるのは1秒に1回）。消せない（中にファイルがあるなど）ときは、ふつうに待ち続ける
  if [ $((i % 10)) -eq 0 ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null; then continue; fi
  sleep 0.1
  i=$((i + 1))
done
"$player" "$wav" >/dev/null 2>&1
status=$?
[ "$held" = 1 ] && rmdir "$lock" 2>/dev/null
exit "$status"
