import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CaffeineManager } from "../src/caffeine.ts";
import type { CaffeineConfig } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

class FakeProc extends EventEmitter {
	pid = 9999;
	killed: string[] = [];
	exited = false;
	kill(signal?: string) {
		this.killed.push(signal ?? "SIGTERM");
		return true;
	}
}

interface SpawnCall {
	command: string;
	args: string[];
}

interface ManagerOverrides {
	platform?: "darwin" | "win32" | "linux" | "other";
	logindProbe?: () => boolean;
	now?: () => number;
	config?: Partial<CaffeineConfig>;
}

function makeManager(overrides: ManagerOverrides = {}) {
	const spawns: SpawnCall[] = [];
	const procs: FakeProc[] = [];
	const spawnFn = vi.fn((command: string, args: string[]) => {
		spawns.push({ command, args });
		const p = new FakeProc();
		procs.push(p);
		return p as unknown as ChildProcess;
	});
	const statuses: Array<[string, string | undefined]> = [];
	const ctx = {
		ui: {
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
		},
	} as never;
	const { config: configOverrides, ...rest } = overrides;
	const config: CaffeineConfig = { ...DEFAULT_CONFIG, ...configOverrides };
	const manager = new CaffeineManager({
		platform: rest.platform ?? "darwin",
		pid: 4242,
		config,
		spawnFn: spawnFn as never,
		logindProbe: rest.logindProbe ?? (() => true),
		now: rest.now ?? (() => Date.now()),
	});
	return { manager, spawns, procs, statuses, ctx, spawnFn };
}

describe("CaffeineManager.acquire", () => {
	it("spawns one holder and sets the ☕ status on darwin", () => {
		const { manager, spawns, statuses, ctx } = makeManager();
		manager.acquire(ctx);
		expect(spawns).toHaveLength(1);
		expect(spawns[0].command).toBe("caffeinate");
		expect(statuses).toEqual([["caffeine", "☕"]]);
		expect(manager.state.holder).not.toBeNull();
	});

	it("is idempotent: a second acquire spawns nothing new", () => {
		const { manager, spawns, ctx } = makeManager();
		manager.acquire(ctx);
		manager.acquire(ctx);
		expect(spawns).toHaveLength(1);
	});

	it("does nothing when enabled=false", () => {
		const { manager, spawns, statuses, ctx } = makeManager({ config: { enabled: false } });
		manager.acquire(ctx);
		expect(spawns).toHaveLength(0);
		expect(statuses).toHaveLength(0);
	});

	it("does nothing on unsupported platforms", () => {
		const { manager, spawns, statuses, ctx } = makeManager({ platform: "other" });
		manager.acquire(ctx);
		expect(spawns).toHaveLength(0);
		expect(statuses).toHaveLength(0);
	});

	it("does nothing on linux without logind", () => {
		const { manager, spawns, ctx } = makeManager({ platform: "linux", logindProbe: () => false });
		manager.acquire(ctx);
		expect(spawns).toHaveLength(0);
	});

	it("passes maxHoldMinutes through to the holder command", () => {
		const { manager, spawns, ctx } = makeManager({ config: { maxHoldMinutes: 60 } });
		manager.acquire(ctx);
		expect(spawns[0].args.join(" ")).toContain("3600");
	});

	it("uses the configured status symbol", () => {
		const { manager, statuses, ctx } = makeManager({ config: { statusSymbol: "ZZZ" } });
		manager.acquire(ctx);
		expect(statuses).toEqual([["caffeine", "ZZZ"]]);
	});
});

describe("CaffeineManager.release", () => {
	it("kills the holder, clears state, and clears the status", () => {
		const { manager, procs, statuses, ctx } = makeManager();
		manager.acquire(ctx);
		manager.release(ctx);
		expect(procs[0].killed).toEqual(["SIGTERM"]);
		expect(manager.state.holder).toBeNull();
		expect(statuses.at(-1)).toEqual(["caffeine", undefined]);
	});

	it("is idempotent: release without a holder does nothing", () => {
		const { manager, procs, statuses, ctx } = makeManager();
		manager.release(ctx);
		expect(procs).toHaveLength(0);
		expect(statuses).toHaveLength(0);
	});

	it("SIGKILLs after the grace period if the holder ignores SIGTERM", () => {
		vi.useFakeTimers();
		try {
			const { manager, procs, ctx } = makeManager();
			manager.acquire(ctx);
			manager.release(ctx);
			// The holder ignores SIGTERM: no "exit" event is emitted, so after
			// the grace period the manager must escalate to SIGKILL.
			vi.advanceTimersByTime(2500);
			expect(procs[0].killed).toEqual(["SIGTERM", "SIGKILL"]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("CaffeineManager crash handling", () => {
	it("nulls the handle when the holder exits on its own (watchdog fired)", () => {
		const { manager, procs, ctx } = makeManager();
		manager.acquire(ctx);
		const holder = manager.state.holder;
		expect(holder).not.toBeNull();
		procs[0].emit("exit", 0, null);
		expect(manager.state.holder).toBeNull();
		expect(holder!.exited).toBe(true);
	});

	it("a new acquire after a crash-exit spawns a fresh holder", () => {
		const { manager, spawns, procs, ctx } = makeManager();
		manager.acquire(ctx);
		procs[0].emit("exit", 0, null);
		manager.acquire(ctx);
		expect(spawns).toHaveLength(2);
	});
});

describe("CaffeineManager.describe", () => {
	it("reports held state with platform and pid", () => {
		const { manager, procs, ctx } = makeManager();
		manager.acquire(ctx);
		const text = manager.describe();
		expect(text).toContain("☕");
		expect(text).toContain("darwin");
		expect(text).toContain(String(procs[0].pid));
	});

	it("reports not-held state", () => {
		const { manager } = makeManager();
		expect(manager.describe()).toBe("no wake assertion held");
	});

	it("reports unsupported platform", () => {
		const { manager } = makeManager({ platform: "other" });
		expect(manager.describe()).toContain("not supported");
	});
});
