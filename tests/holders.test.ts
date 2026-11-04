import { describe, expect, it } from "vitest";
import {
	buildHolderCommand,
	detectPlatform,
	DEFAULT_MAX_HOLD_MINUTES,
	linuxHasLogind,
} from "../src/holders.ts";

const PI_PID = 4242;

describe("detectPlatform", () => {
	it("maps process.platform values", () => {
		expect(detectPlatform("darwin")).toBe("darwin");
		expect(detectPlatform("win32")).toBe("win32");
		expect(detectPlatform("linux")).toBe("linux");
		expect(detectPlatform("freebsd")).toBe("other");
	});
});

describe("buildHolderCommand - darwin", () => {
	const cmd = buildHolderCommand("darwin", PI_PID, 1440)!;

	it("uses caffeinate with the pi pid watcher and the time cap", () => {
		expect(cmd.command).toBe("caffeinate");
		expect(cmd.args).toContain("-w");
		expect(cmd.args[cmd.args.indexOf("-w") + 1]).toBe(String(PI_PID));
		expect(cmd.args).toContain("-t");
		expect(cmd.args[cmd.args.indexOf("-t") + 1]).toBe(String(1440 * 60));
	});

	it("asserts the exact flag/value order", () => {
		expect(cmd.args).toEqual(["-dius", "-w", "4242", "-t", "86400"]);
	});
});

describe("buildHolderCommand - win32", () => {
	const cmd = buildHolderCommand("win32", PI_PID, 1440)!;

	it("runs powershell in no-profile mode", () => {
		expect(cmd.command.toLowerCase()).toContain("powershell");
		expect(cmd.args.map((a) => a.toLowerCase())).toContain("-noprofile");
	});

	it("sets ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED (0x80000003)", () => {
		const script = cmd.args.join(" ");
		expect(script).toContain("SetThreadExecutionState");
		expect(script).toContain("0x80000000");
		expect(script).toMatch(/-bor\s+3\b/);
	});

	it("contains a watchdog that exits when the pi pid disappears", () => {
		const script = cmd.args.join(" ");
		expect(script).toContain("Get-Process -Id");
		expect(script).toContain(String(PI_PID));
	});

	it("contains the 24h-style deadline from maxHoldMinutes", () => {
		expect(cmd.args.join(" ")).toContain("AddMinutes(1440)");
	});
});

describe("buildHolderCommand - linux", () => {
	const cmd = buildHolderCommand("linux", PI_PID, 1440)!;

	it("wraps a watchdog with systemd-inhibit sleep:idle block lock", () => {
		expect(cmd.command).toBe("systemd-inhibit");
		expect(cmd.args.join(" ")).toContain("--what=sleep:idle");
		expect(cmd.args.join(" ")).toContain("--mode=block");
	});

	it("the watchdog shell loop checks the pi pid and the deadline", () => {
		const script = cmd.args.join(" ");
		expect(script).toContain(`kill -0 ${PI_PID}`);
		expect(script).toContain("86400"); // 1440 min in seconds
	});
});

describe("buildHolderCommand - other", () => {
	it("returns null for unsupported platforms", () => {
		expect(buildHolderCommand("other", PI_PID, 1440)).toBeNull();
	});
});

describe("DEFAULT_MAX_HOLD_MINUTES", () => {
	it("is 24 h", () => {
		expect(DEFAULT_MAX_HOLD_MINUTES).toBe(1440);
	});
});

describe("linuxHasLogind", () => {
	it("is true when systemd-inhibit exists (probed via execFileSync)", () => {
		// This runs on the dev mac, so logind is absent: expect false.
		expect(linuxHasLogind(() => { throw new Error("not found"); })).toBe(false);
		expect(linuxHasLogind(() => ({ status: 0 }))).toBe(true);
	});
});
