ZenkaiTV player top-bar mascot
==============================

Drop the nine mascot poses here, numbered:

  frieren-1   mimic chest
  frieren-2   standing idle
  frieren-3   holding closed book
  frieren-4   staff, moving
  frieren-5   staff, casting
  frieren-6   sitting, reading
  frieren-7   standing, reading
  frieren-8   reading, hand raised (page turn)
  frieren-9   standing idle (second)

GIF or PNG - either works, and you can mix them. The loader tries
frieren-<n>.gif first and falls back to frieren-<n>.png, so just name them by
number and use whichever format each pose needs. Animated GIFs animate on their
own; stills simply hold.

The player rotates through the poses with a slow cross-fade (5-9 seconds each,
see MASCOT_POSES in player/player.js to retune the order or timings), so the bar
keeps changing over time.

Sizing: scaled to the bar height (max 64px tall), aspect ratio preserved.
Transparent background. 128x128 or 192x192 is plenty.

Behaviour:
  - a pose that is missing        -> dropped from the rotation
  - no poses present at all       -> the slot removes itself, bar looks untouched
  - screens under 900px           -> hidden (no spare room in the bar)
  - prefers-reduced-motion        -> hidden

After adding them:
  cp -r mascot android/app/src/main/assets/
  node scripts/bump-asset-version.mjs
