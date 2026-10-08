#!/bin/sh
# play.sh のロックの検査（macOS・Linux の CI と Git Bash で動く）。
#   sh tests/posix/test-play-lock.sh
# 1. 2本を同時に鳴らしても重ならない  2. 消せない古いロックがあっても、待ちきって鳴らす（止まらない）
set -u
here=$(cd "$(dirname "$0")" && pwd)
play="$here/../../scripts/posix/play.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0

# 偽のプレイヤー：始まりと終わりを記録し、1秒かかる
cat > "$work/player" <<'P'
#!/bin/sh
echo "start $1" >> "$(dirname "$0")/events"
sleep 1
echo "end $1" >> "$(dirname "$0")/events"
P
chmod +x "$work/player"

sh "$play" "$work/lock" "$work/player" a &
sh "$play" "$work/lock" "$work/player" b &
wait
order=$(tr '\n' ' ' < "$work/events")
case "$order" in
  "start a end a start b end b "|"start b end b start a end a ") echo "ok   重ならない: $order" ;;
  *) echo "NG   重なった: $order"; fail=1 ;;
esac

# 中にファイルがあって rmdir できない古いロック（2000年の日付）
mkdir "$work/stale"; : > "$work/stale/keep"; touch -t 200001010000 "$work/stale"
# 待つのは約20秒（プロセスの起動が遅い環境ではもう少し）。回り続ける不具合を捕まえるため、90秒で見切る
sh "$play" "$work/stale" "$work/player" c &
pid=$!
took=0
while kill -0 "$pid" 2>/dev/null && [ "$took" -lt 90 ]; do sleep 1; took=$((took + 1)); done
if kill -0 "$pid" 2>/dev/null; then kill "$pid"; echo "NG   消せないロックで 90 秒たっても終わらない"; fail=1
elif [ "$took" -le 60 ] && grep -q "end c" "$work/events"; then echo "ok   消せないロックでも ${took} 秒で鳴らした"
else echo "NG   消せないロックで ${took} 秒（60 秒以内に鳴るはず）"; fail=1; fi

exit "$fail"
