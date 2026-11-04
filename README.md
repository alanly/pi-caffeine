# pi-caffeine

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that keeps
your computer awake **while Pi is working**. It holds a native OS wake
assertion during each agent run and shows a ☕ in the footer status line.

| Platform | Mechanism | Crash safety |
|---|---|---|
| macOS | `caffeinate -dius -w <piPid>` | `-w` makes caffeinate exit when Pi dies |
| Linux (systemd) | `systemd-inhibit --what=sleep:idle` | watchdog loop exits when Pi's PID disappears |
| Windows | `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED \| ES_DISPLAY_REQUIRED)` via PowerShell | watchdog loop exits when Pi's PID disappears |

- Assertion starts at `agent_start`, released at `agent_settled` (the
  final-idle signal, so retries and queued messages keep the machine awake).
- Footer shows `☕` while held; gone when released. Headless modes are a
  safe no-op.
- Hard cap of 24 h (configurable) so a forgotten run cannot hold the lock
  forever.
- `/caffeine` shows the current state (platform, holder PID, elapsed time).
- Crash-safe: if Pi is SIGKILLed, the holder notices the dead PID and exits,
  and the OS releases the assertion automatically.

## Install

Dev checkout (like this repo):

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["../../src/github.com/alanly/pi-caffeine"]
}
```

or directly:

```jsonc
{
  "extensions": ["extensions/pi-caffeine/index.ts"]
}
```

## Settings (all optional)

```jsonc
{
  "caffeine": {
    "enabled": true,
    "maxHoldMinutes": 1440,
    "statusSymbol": "☕"
  }
}
```

## Verify on the host

- macOS: `pmset -g assertions`
- Linux: `systemd-inhibit --list`
- Windows: `powercfg /requests`

## Development

```sh
npm install
npm test         # vitest
npm run typecheck
```

See [DESIGN.md](DESIGN.md) for the full technical design.
