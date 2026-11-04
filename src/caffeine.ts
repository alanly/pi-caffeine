/**
 * The CaffeineManager owns the wake assertion lifecycle: acquire on
 * agent_start, release on agent_settled / session_shutdown. All operations
 * are idempotent. Spawn and the clock are injectable for tests.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildHolderCommand, detectPlatform, linuxHasLogind } from "./holders.ts";
import { formatStatus, STATUS_KEY } from "./statusline.ts";
import type { CaffeineConfig, CaffeineState, HolderHandle, Platform } from "./types.ts";

/** Grace period after SIGTERM before SIGKILL on release. */
export const KILL_GRACE_MS = 2000;

export type SpawnFn = typeof spawn;
export type LogindProbe = () => boolean;

export interface CaffeineManagerOptions {
	platform?: Platform;
	pid?: number;
	config: CaffeineConfig;
	spawnFn?: SpawnFn;
	logindProbe?: LogindProbe;
	now?: () => number;
}

export class CaffeineManager {
	readonly state: CaffeineState = { holder: null };

	private readonly platform: Platform;
	private readonly pid: number;
	private readonly config: CaffeineConfig;
	private readonly spawnFn: SpawnFn;
	private readonly logindProbe: LogindProbe;
	private readonly now: () => number;
	private killTimer: NodeJS.Timeout | null = null;
	// Last ctx seen by acquire/release. The holder's exit event fires outside
	// any event handler and has no ctx parameter, so the captured ctx is the
	// only way to clear the ☕ status when the holder exits on its own.
	private lastCtx: ExtensionContext | null = null;

	constructor(options: CaffeineManagerOptions) {
		this.platform = options.platform ?? detectPlatform(process.platform);
		this.pid = options.pid ?? process.pid;
		this.config = options.config;
		this.spawnFn = options.spawnFn ?? spawn;
		this.logindProbe = options.logindProbe ?? (() => linuxHasLogind());
		this.now = options.now ?? (() => Date.now());
	}

	/** True when a holder can be spawned on this host. */
	private supported(): boolean {
		if (this.platform === "other") return false;
		if (this.platform === "linux" && !this.logindProbe()) return false;
		return true;
	}

	/** Acquire the assertion if none is held. Idempotent. */
	acquire(ctx: ExtensionContext): void {
		this.lastCtx = ctx;
		if (!this.config.enabled) return;
		if (this.state.holder !== null) return;
		if (!this.supported()) return;

		const cmd = buildHolderCommand(this.platform, this.pid, this.config.maxHoldMinutes);
		if (cmd === null) return;

		const proc = this.spawnFn(cmd.command, cmd.args, { stdio: "ignore" });
		const handle: HolderHandle = { proc, platform: this.platform, startedAt: this.now() };
		this.state.holder = handle;

		// If the holder exits on its own (watchdog fired, cap reached, or it
		// was killed), clear the handle so the next acquire can spawn again.
		// Always clear the pending kill timer and the ☕ status on exit: the
		// exit event has no ctx, so use the last captured one.
		proc.on("exit", () => {
			handle.exited = true;
			if (this.killTimer !== null) {
				clearTimeout(this.killTimer);
				this.killTimer = null;
			}
			if (this.state.holder?.proc === proc) {
				this.state.holder = null;
				if (this.lastCtx !== null) this.syncStatus(this.lastCtx);
			}
		});

		this.syncStatus(ctx);
	}

	/** Release the assertion. Idempotent. SIGTERM first, SIGKILL after the grace period. */
	release(ctx: ExtensionContext): void {
		this.lastCtx = ctx;
		const holder = this.state.holder;
		if (holder !== null) {
			this.state.holder = null;
			holder.proc.kill("SIGTERM");
			this.killTimer = setTimeout(() => {
				this.killTimer = null;
				// SIGKILL only if the holder ignored SIGTERM (has not exited yet).
				if (!holder.exited) holder.proc.kill("SIGKILL");
			}, KILL_GRACE_MS);
			// Do not keep the pi process alive just for this timer.
			this.killTimer.unref?.();
		}
		// Always sync, even when nothing was held, so a stale ☕ from a
		// self-exited holder is cleared on the next event.
		this.syncStatus(ctx);
	}

	/** Human-readable state for the /caffeine command. Read-only. */
	describe(): string {
		const holder = this.state.holder;
		if (holder === null) {
			if (!this.supported()) return "wake assertions are not supported on this platform";
			if (!this.config.enabled) return "wake assertions disabled by settings (caffeine.enabled=false)";
			return "no wake assertion held";
		}
		const minutes = Math.max(0, Math.round((this.now() - holder.startedAt) / 60_000));
		return `☕ wake assertion held (${holder.platform}, holder pid ${holder.proc.pid ?? "?"}, held for ${minutes} min)`;
	}

	private syncStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, formatStatus(this.state, this.config.statusSymbol));
	}
}
