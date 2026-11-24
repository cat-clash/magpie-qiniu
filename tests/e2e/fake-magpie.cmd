@echo off
rem fake magpie CLI for e2e tests. ASCII only: cmd.exe reads batch files with the OEM code page.
rem Prefers node, falls back to bun when node is not on PATH.
set "TARGET=%~dp0fake-magpie.mjs"
if defined FAKE_MAGPIE_NODE goto runenv
where node >nul 2>nul
if errorlevel 1 goto runbun
set "RUNNER=node"
goto run
:runenv
set "RUNNER=%FAKE_MAGPIE_NODE%"
goto run
:runbun
set "RUNNER=bun"
:run
"%RUNNER%" "%TARGET%" %*
exit /b %ERRORLEVEL%
