# pi-caffeine: Technical Design

This document gives the technical design for the pi-caffeine extension. The
extension keeps the host computer awake while the Pi agent is working. It
holds a native wake assertion on macOS, Windows, and Linux with systemd. A
coffee-cup symbol in the footer status line shows that the assertion is held.

Target: Pi 1.0.0 and later. All APIs in this document were verified against
the installed `@earendil-works/pi-coding-agent` 1.5.0. Verification files:
`docs/extensions.md`, `examples/extensions/status-line.ts`, and
`dist/core/extensions/types.d.ts`.

Document standard: this document obeys the ASD-STE100 Simplified Technical
English rules where the rules apply to a design document. Code blocks, file
paths, and quoted tool text are not controlled prose.

## Abbreviations and terms

| Term | Meaning |
|---|---|
| API | application programming interface |
| TUI | terminal user interface |
| assertion | a request to the operating system to stay awake |
| holder | the child process that holds the assertion |
| inhibitor lock | the systemd-logind lock that blocks sleep and idle |
| execution state | the Windows per-thread flag that blocks sleep |
| watchdog | a loop in the holder that exits when the parent process ends |
| fd | file descriptor |

---

## 1. Requirements

| # | Requirement |
|---|---|
| R1 | The extension shall hold a wake assertion while an agent run is active. The assertion shall start at `agent_start`. |
| R2 | The extension shall release the assertion when the agent settles. The release point is `agent_settled`, not `agent_end`, because Pi can retry or continue with queued messages after `agent_end`. |
| R3 | The release and acquire operations shall be idempotent. A repeated `agent_start` while an assertion is held shall not spawn a second holder. |
| R4 | The footer status line shall show a coffee-cup symbol (U+2615) while the assertion is held. The symbol shall disappear when the assertion is released. |
| R5 | The extension shall support macOS, Windows, and Linux with systemd-logind. Other platforms shall be a silent no-op. |
| R6 | If Pi crashes or is killed, the assertion shall end without a manual step. Each platform holder shall watch the Pi process ID and exit when the PID disappears. |
| R7 | Each holder shall have a maximum duration. After the duration, the holder shall exit even if Pi still runs. |
| R8 | The extension shall release the assertion at `session_shutdown` (quit, reload, new, resume, fork). The cleanup shall be idempotent. |
| R9 | The extension shall expose one slash command, `/caffeine`, that shows the current state: held or not held, the platform, and the holder PID. |
| R10 | The extension shall work in headless modes (`-p`, JSON, RPC). In these modes `ctx.ui.setStatus` is a no-op and the extension shall not fail. |

---

## 2. Architecture

The extension is one directory of TypeScript files. Pi loads the extension
with jiti. No build step is necessary.

```
pi-caffeine/
├── index.ts            # factory. Wires events, command, and shutdown.
├── src/
│   ├── types.ts        # Platform, AwakeState, HolderHandle
│   ├── holders.ts      # per-platform spawn functions (darwin, win32, linux)
│   ├── caffeine.ts     # Caffeine manager: acquire / release / state
│   └── statusline.ts   # footer text formatting and setStatus calls
├── tests/              # vitest unit tests with a fake spawn
├── package.json        # dev dependencies only; "pi" field for packages
├── tsconfig.json
├── DESIGN.md
└── README.md
```

Initialization (`index.ts`):

```ts
export default function (pi: ExtensionAPI) {
  const manager = new CaffeineManager(pi);
  pi.on("agent_start", (_event, ctx) => manager.acquire(ctx));
  pi.on("agent_settled", (_event, ctx) => manager.release(ctx));
  pi.on("session_shutdown", (_event, ctx) => manager.release(ctx));
  pi.registerCommand("caffeine", {
    description: "Show the wake-assertion state",
    handler: async (_args, ctx) => { ctx.ui.notify(manager.describe(), "info"); },
  });
}
```

Obey the Pi lifecycle rules:

- Do not spawn processes in the factory. Spawn only in an event handler.
- Do the cleanup in the `session_shutdown` handler. The handler shall be
  idempotent.
- `ctx` is not a factory parameter. Use the `ctx` parameter of the event
  handler and of the command handler.

---

## 3. Core state

```ts
// src/types.ts
type Platform = "darwin" | "win32" | "linux" | "other";

interface HolderHandle {
  proc: ChildProcess;   // the spawned holder process
  platform: Platform;
  startedAt: number;    // Date.now()
}

interface CaffeineState {
  holder: HolderHandle | null;  // null = no assertion held
}
```

The manager keeps one `CaffeineState`. The operations are:

- `acquire(ctx)`: if `holder` is not null, do nothing (R3). Otherwise spawn
  the platform holder, store the handle, and set the status line (R4).
- `release(ctx)`: if `holder` is null, do nothing. Otherwise send SIGTERM to
  the holder, set `holder` to null, and clear the status line.
- `describe()`: return a human-readable state string for `/caffeine`.

Spawn injection for tests: the manager takes a `spawnFn` parameter. The
default is `child_process.spawn`. Tests pass a fake that returns an EventEmitter
with a `kill` method.

---

## 4. Platform holders

All holders follow one rule: the holder process exits when the Pi PID
disappears, and the holder exits after `MAX_HOLD_MS`. When the holder exits,
the operating system releases the assertion automatically.

`MAX_HOLD_MS` default: 86,400,000 ms (24 h).

### 4.1 macOS (darwin)

Spawn:

```
caffeinate -dius -w <piPid> -t 86400
```

- `-i` prevents idle sleep, `-d` keeps the display on, `-u` marks user-idle
  activity, `-s` prevents system sleep on AC power.
- `-w <piPid>` makes caffeinate exit by itself when the Pi PID disappears.
  This is the crash-safety mechanism (R6). No watchdog loop is needed.
- `-t 86400` caps the assertion at 24 h (R7) even if `-w` somehow fails.

Verify on the host: `pmset -g assertions` lists caffeinate as the owner.

### 4.2 Windows (win32)

Spawn PowerShell with the Pi PID injected:

```powershell
$piPid = <piPid>
Add-Type -Namespace Win32 -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][Win32.P]::SetThreadExecutionState([uint32]0x80000000 -bor 3)
$deadline = (Get-Date).AddHours(24)
while ((Get-Date) -lt $deadline -and (Get-Process -Id $piPid -ErrorAction SilentlyContinue)) { Start-Sleep 5 }
```

- `0x80000000` is `ES_CONTINUOUS`, `1` is `ES_SYSTEM_REQUIRED`, `2` is
  `ES_DISPLAY_REQUIRED`. The `-bor 3` adds `ES_SYSTEM_REQUIRED` and
  `ES_DISPLAY_REQUIRED`.
- The loop is the watchdog (R6): when the Pi PID disappears, the loop ends.
- When the PowerShell process exits, Windows clears the thread execution
  state automatically. The 24 h deadline caps the hold (R7).

Spawn as: `powershell -NoProfile -Command <script>` with `stdio: "ignore"`.

Verify on the host: `powercfg /requests`.

### 4.3 Linux with systemd-logind (linux)

Probe first: `systemd-inhibit --list` exits 0 when logind is present. If the
probe fails, the platform is treated as `other` and acquire is a no-op.

Spawn:

```
systemd-inhibit --what=sleep:idle --mode=block --who=pi --why="pi agent run active" \
  sh -c 'end=$(( $(date +%s) + 86400 )); while kill -0 <piPid> 2>/dev/null && [ $(date +%s) -lt $end ]; do sleep 5; done'
```

- `sh` wrapper is the watchdog (R6): `kill -0 <piPid>` fails when Pi dies.
- When the `sh` exits, `systemd-inhibit` exits. The logind inhibitor fd
  closes and the kernel releases the lock automatically.
- The 86400-second deadline caps the hold (R7).

Verify on the host: `systemd-inhibit --list`.

### 4.4 Other platforms

`acquire` is a silent no-op. The status line is not set. `/caffeine` reports
`unsupported platform`.

### 4.5 Spawn parameters, all platforms

- `stdio: "ignore"` so the holder never blocks the Pi output.
- `detached: false`. The holder is a normal child of Pi. Pi's own exit does
  not kill the holder; the watchdog handles that.
- Do not `unref` the holder. The manager tracks the handle and kills it on
  release, so the Node event loop stays correct.

On the release path, send SIGTERM first. If the process does not exit within
2 s, send SIGKILL. This mirrors the kill pattern of pi-bg-tasks.

---

## 5. Status line

Use `ctx.ui.setStatus` with the key `caffeine`:

- Acquire: `ctx.ui.setStatus("caffeine", "☕")`.
- Release: `ctx.ui.setStatus("caffeine", undefined)`.

Rules:

- `setStatus` is a no-op in headless modes. No `ctx.hasUI` guard is needed (R10).
  In RPC mode the status is forwarded; the extension does not need special code.
- The emoji needs no theme color. Pass the plain string `☕`.
- The status persists until cleared. Clear it in every release path:
  `agent_settled`, `session_shutdown`, and the holder-exit handler.

The holder-exit handler matters for the crash case: if the holder exits on
its own (watchdog fired, or 24 h cap), the manager shall clear the status on
the next event. The manager listens to the holder `exit` event and nulls the
handle so a later `agent_start` can acquire again.

Status line module (`src/statusline.ts`) keeps one pure function:

```ts
formatStatus(state: CaffeineState): string | undefined {
  return state.holder ? "☕" : undefined;
}
```

The manager calls `ctx.ui.setStatus("caffeine", formatStatus(state))` after
every state change. This keeps the footer and the state in sync by
construction.

---

## 6. Slash command

`/caffeine` with no arguments prints the state via `ctx.ui.notify`:

- Held: `☕ wake assertion held (darwin, holder pid 1234, held for 3 min)`.
- Not held: `no wake assertion held`.
- Unsupported: `wake assertions not supported on this platform`.

The command does not change the state. It is read-only.

---

## 7. Crash and kill matrix

| Event | macOS | Linux | Windows |
|---|---|---|---|
| Pi exits normally | `session_shutdown` kills holder | `session_shutdown` kills holder | `session_shutdown` kills holder |
| Pi gets SIGTERM | `session_shutdown` runs; handler kills holder | same | same |
| Pi gets SIGKILL | `caffeinate -w` sees PID gone and exits; IOKit releases assertion | watchdog `kill -0` fails; `sh` exits; logind fd closes | watchdog `Get-Process` fails; PowerShell exits; state clears |
| Holder is killed manually | assertion released by OS; manager nulls handle on `exit` event | same | same |
| 24 h cap reached | `-t 86400` exits caffeinate | deadline in `sh` loop exits | deadline in PowerShell loop exits |

The manager's `exit` handler on the holder:

```ts
proc.on("exit", () => {
  if (manager.state.holder?.proc === proc) {
    manager.state.holder = null;
    // status line is refreshed on the next event handler call
  }
});
```

---

## 8. Settings

The extension reads optional settings from `pi.getSettings()` at
`session_start` (not in the factory; the settings API is not available
during extension loading):

```json
"caffeine": {
  "enabled": true,
  "maxHoldMinutes": 1440,
  "statusSymbol": "☕"
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` disables acquire; the extension stays loaded but inert |
| `maxHoldMinutes` | `1440` | max hold duration in minutes; passed to the holder |
| `statusSymbol` | `☕` | the footer symbol |

All keys are optional. Missing keys use the defaults.

---

## 9. Test plan

Unit tests with vitest. No real spawns; a fake `spawnFn` records arguments.

1. `acquire` on darwin spawns `caffeinate` with `-w <pid>` and `-t`.
2. `acquire` on win32 spawns `powershell` with a script that contains the
   Pi PID and `SetThreadExecutionState`.
3. `acquire` on linux spawns `systemd-inhibit` with `sleep:idle` and a
   watchdog that contains the Pi PID.
4. `acquire` twice spawns only one holder (idempotent, R3).
5. `release` kills the holder and sends SIGTERM; a second `release` is a
   no-op.
6. `release` after SIGKILL sends SIGKILL if the process is still alive after
   2 s (fake timers).
7. `formatStatus` returns `☕` when held and `undefined` when not held.
8. `acquire` on `other` platform spawns nothing and sets no status.
9. `enabled: false` setting makes `acquire` a no-op.
10. Holder `exit` event nulls the handle; a following `acquire` spawns a new
    holder.
11. `describe()` output contains the platform and PID when held.
12. `setStatus` is called with the key `caffeine` on acquire and with
    `undefined` on release (fake ctx).
13. `maxHoldMinutes` appears in the spawn arguments as the cap.
14. `session_shutdown` handler calls `release` (idempotent cleanup, R8).

Integration smoke (manual, in a real Pi session):

15. Start Pi with the extension. Send a prompt that takes time. While the
    run is active, the footer shows ☕ and `pmset -g assertions` (macOS)
    shows caffeinate.
16. After the run settles, ☕ disappears.
17. `kill -9` the Pi process. Within 10 s the assertion is gone
    (`pmset -g assertions` no longer lists it).
18. `/caffeine` prints the held state with PID while a run is active.

---

## 10. Open questions

1. Should the ☕ also show while a queued-message run is pending between
   `agent_end` and the next `agent_start`? Decision: no. The assertion ties
   to `agent_start`/`agent_settled` only. Rationale: `agent_settled` is the
   documented final-idle signal.
2. Should the extension also inhibit shutdown (Linux `what=shutdown`,
   Windows nothing extra)? Decision: no. Sleep and idle only. A user who
   wants to block shutdown can ask Pi to run `systemctl` commands itself.
