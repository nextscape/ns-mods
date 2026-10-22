#!/bin/sh
# Plays a wav for voice-notify (macOS, Linux). The mod (hooks/speak.ts) calls it:
#   play.sh <lock directory> <player> <wav>
# Clips of two sessions at once cannot be made out, so only the one that makes
# the lock directory plays (of mkdir calls made together, one succeeds).
# When the lock is not free after 20 seconds, the clip plays over the other. A
# lock left for over a minute is taken for a dead process's and removed.
lock=$1
player=$2
wav=$3
held=0
i=0
while [ "$i" -lt 200 ]; do
  if mkdir "$lock" 2>/dev/null; then held=1; break; fi
  # A stale lock is removed and taken again at once (checked once a second).
  # One that cannot be removed (a file inside, say) is simply waited on.
  if [ $((i % 10)) -eq 0 ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null; then continue; fi
  sleep 0.1
  i=$((i + 1))
done
"$player" "$wav" >/dev/null 2>&1
status=$?
[ "$held" = 1 ] && rmdir "$lock" 2>/dev/null
exit "$status"
