ZenkaiTV player top-bar mascot
==============================

Drop ONE animated GIF here, named exactly:

  frieren.gif

It renders in the empty middle of the player title bar, between the episode
title and the ZenkaiTV wordmark. The GIF itself supplies the animation - there
is no JS frame loop and no CSS keyframes, so whatever timing you export is
exactly what plays.

Sizing: the player scales it to the bar height (max 64px tall) and keeps the
aspect ratio, so export at any square-ish size. Transparent background.
Roughly 128x128 or 192x192 is plenty; keep the file small since it sits in the
player shell.

Behaviour:
  - missing file        -> the slot removes itself, bar looks untouched
  - screens under 900px -> hidden (no spare room in the bar)
  - prefers-reduced-motion -> hidden, since a GIF cannot be paused from CSS

After adding it:
  cp -r mascot android/app/src/main/assets/
  node scripts/bump-asset-version.mjs
