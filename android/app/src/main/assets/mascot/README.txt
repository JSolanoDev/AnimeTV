ZenkaiTV player top-bar mascot
==============================

Drop the nine chibi sprites here, named exactly:

  frieren-1.png   mimic chest
  frieren-2.png   standing idle
  frieren-3.png   holding closed book
  frieren-4.png   staff, moving
  frieren-5.png   staff, casting
  frieren-6.png   sitting, reading
  frieren-7.png   standing, reading
  frieren-8.png   reading, hand raised (page turn)
  frieren-9.png   standing idle (second idle)

PNG with transparency. Any square-ish size works - the player scales them to the
bar height (max 62px tall) and keeps the aspect ratio.

The animation sequence and hold times live in startMascot() in player/player.js.
If these files are absent the mascot removes itself, so the bar looks exactly as
it did before. Nothing else depends on them.

After adding them, mirror the folder to android/app/src/main/assets/mascot/ and
run `node scripts/bump-asset-version.mjs` so clients pick up the change.
