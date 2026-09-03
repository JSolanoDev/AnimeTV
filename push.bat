@echo off
REM ============================================================
REM  ZenkaiTV - safe push
REM ============================================================
REM  Commits nothing. It only publishes commits you already made.
REM  Handles the two things that break a plain "git push" here:
REM    1. the bot pushes "chore: update anime catalog" commits, so
REM       your branch is usually behind and must rebase first;
REM    2. rebase refuses to run while the working tree is dirty,
REM       and this tree always has WIP - so it is stashed and
REM       restored around the rebase.
REM  If anything fails it restores your WIP and stops.
REM ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set STASHED=

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Not a git repository: %CD%
  goto :fail
)

for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%i
echo [1/5] Branch: !BRANCH!

REM --- stash tracked WIP so rebase can run (untracked files are left alone) ---
git diff-index --quiet HEAD -- >nul 2>&1
if errorlevel 1 (
  echo [2/5] Stashing local changes...
  git stash push -m "autopush-wip" >nul
  if errorlevel 1 (
    echo [ERROR] Could not stash your changes. Nothing was pushed.
    goto :fail
  )
  set STASHED=1
) else (
  echo [2/5] Working tree clean, nothing to stash.
)

echo [3/5] Fetching origin...
git fetch origin
if errorlevel 1 (
  echo [ERROR] Fetch failed - check your network or credentials.
  goto :restore
)

echo [4/5] Rebasing onto origin/!BRANCH!...
git rebase origin/!BRANCH!
if errorlevel 1 (
  echo.
  echo [ERROR] Rebase hit a conflict. Rolling back - nothing was pushed.
  git rebase --abort >nul 2>&1
  goto :restore
)

echo [5/5] Pushing...
git push origin !BRANCH!
if errorlevel 1 (
  echo [ERROR] Push failed. Your commits are still local.
  goto :restore
)

echo.
echo [OK] Pushed to origin/!BRANCH!. Vercel will deploy shortly.
echo      Remember to hard-refresh (Ctrl+Shift+R) so the new
echo      service worker version activates.
goto :restore_ok

:restore
if defined STASHED (
  echo Restoring your local changes...
  git stash pop
  if errorlevel 1 echo [WARN] Stash pop had conflicts - run "git stash list" to recover.
)
goto :fail

:restore_ok
if defined STASHED (
  echo Restoring your local changes...
  git stash pop
  if errorlevel 1 echo [WARN] Stash pop had conflicts - run "git stash list" to recover.
)
echo.
echo Done.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
