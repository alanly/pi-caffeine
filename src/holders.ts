/**
 * Per-platform holder commands. Every holder follows one rule: the holder
 * process exits when the Pi PID disappears, and it exits after the max-hold
 * cap. When the holder exits, the operating system releases the assertion
 * automatically (IOKit assertion on macOS, logind lock fd on Linux, thread
 * execution state on Windows).
 */

import { execFileSync } from "node:child_process";
import { DEFAULT_MAX_HOLD_MINUTES } from "./config.ts";
import type { HolderCommand, Platform } from "./types.ts";

export { DEFAULT_MAX_HOLD_MINUTES };

/** Map process.platform to a supported platform family. */
export function detectPlatform(platform: NodeJS.Platform): Platform {
	switch (platform) {
		case "darwin":
			return "darwin";
		case "win32":
			return "win32";
		case "linux":
			return "linux";
		default:
			return "other";
	}
}

/** True when systemd-logind is reachable on a Linux host. */
export function linuxHasLogind(probe: () => unknown = () => execFileSync("systemd-inhibit", ["--list"], { stdio: "ignore" })): boolean {
	try {
		probe();
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the holder command for a platform. Returns null for unsupported
 * platforms. `pid` is the Pi process ID used by the crash watchdog.
 * `maxHoldMinutes` is the hard cap passed to the holder.
 */
export function buildHolderCommand(platform: Platform, pid: number, maxHoldMinutes: number = DEFAULT_MAX_HOLD_MINUTES): HolderCommand | null {
	switch (platform) {
		case "darwin":
			return buildDarwin(pid, maxHoldMinutes);
		case "win32":
			return buildWin32(pid, maxHoldMinutes);
		case "linux":
			return buildLinux(pid, maxHoldMinutes);
		default:
			return null;
	}
}

/** macOS: caffeinate holds the assertions; -w <pid> is the built-in crash watchdog. */
function buildDarwin(pid: number, maxHoldMinutes: number): HolderCommand {
	return {
		command: "caffeinate",
		args: ["-dius", "-w", String(pid), "-t", String(maxHoldMinutes * 60)],
	};
}

/**
 * Windows: a PowerShell holder sets ES_CONTINUOUS|ES_SYSTEM_REQUIRED|
 * ES_DISPLAY_REQUIRED (0x80000003) and then loops until the Pi PID disappears
 * or the deadline passes. When the holder exits, Windows clears the state.
 */
function buildWin32(pid: number, maxHoldMinutes: number): HolderCommand {
	const watchdog = [
		`$piPid = ${pid}`,
		`Add-Type -Namespace Win32 -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
		`[void][Win32.P]::SetThreadExecutionState([uint32]0x80000000 -bor 3)`,
		`$deadline = (Get-Date).AddMinutes(${maxHoldMinutes})`,
		`while ((Get-Date) -lt $deadline -and (Get-Process -Id $piPid -ErrorAction SilentlyContinue)) { Start-Sleep 5 }`,
	].join("; ");
	return { command: "powershell", args: ["-NoProfile", "-Command", watchdog] };
}

/**
 * Linux: systemd-inhibit holds a block lock on sleep:idle for the lifetime of
 * the wrapped command. The wrapped sh loop is the crash watchdog: kill -0
 * fails when Pi dies, the loop exits, systemd-inhibit exits, and the kernel
 * closes the logind lock fd.
 */
function buildLinux(pid: number, maxHoldMinutes: number): HolderCommand {
	const capSeconds = maxHoldMinutes * 60;
	const watchdog = `end=$(( $(date +%s) + ${capSeconds} )); while kill -0 ${pid} 2>/dev/null && [ $(date +%s) -lt $end ]; do sleep 5; done`;
	return {
		command: "systemd-inhibit",
		args: ["--what=sleep:idle", "--mode=block", "--who=pi", "--why=pi agent run active", "sh", "-c", watchdog],
	};
}
