#!/bin/sh
# Checks play.sh's lock (runs in the macOS and Linux CI, and in Git Bash).
#   sh tests/posix/test-play-lock.sh
# 1. Two clips started together do not overlap.  2. A stale lock that cannot be
# removed is waited out, and the clip still plays (nothing hangs).
set -u
here=$(cd "$(dirname "$0")" && pwd)
play="$here/../../scripts/posix/play.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0

# A fake player: records its start and end, and takes a second.
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
  "start a end a start b end b "|"start b end b start a end a ") echo "ok   no overlap: $order" ;;
  *) echo "NG   overlapped: $order"; fail=1 ;;
esac

# A stale lock (dated 2000) that rmdir cannot remove: a file is inside.
mkdir "$work/stale"; : > "$work/stale/keep"; touch -t 200001010000 "$work/stale"
# The wait is about 20 seconds (a little more where processes start slowly).
# Past 90 it is given up on, to catch a loop that never ends.
sh "$play" "$work/stale" "$work/player" c &
pid=$!
took=0
while kill -0 "$pid" 2>/dev/null && [ "$took" -lt 90 ]; do sleep 1; took=$((took + 1)); done
if kill -0 "$pid" 2>/dev/null; then kill "$pid"; echo "NG   a lock that cannot be removed: still running after 90 seconds"; fail=1
elif [ "$took" -le 60 ] && grep -q "end c" "$work/events"; then echo "ok   a lock that cannot be removed: played after ${took} seconds"
else echo "NG   a lock that cannot be removed: ${took} seconds (it should play within 60)"; fail=1; fi

exit "$fail"
