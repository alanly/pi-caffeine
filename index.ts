/**
 * pi-caffeine — keep the host awake while Pi is working.
 *
 * Holds a native OS wake assertion from agent_start to agent_settled:
 *   macOS:   caffeinate -dius -w <piPid> -t <cap>
 *   Linux:   systemd-inhibit --what=sleep:idle  (watchdog watches piPid)
 *   Windows: SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM|ES_DISPLAY)
 * A ☕ in the footer status line shows the assertion is held. If Pi crashes,
 * each holder notices the dead PID and exits, releasing the assertion.
 *
 * The factory starts no process and no timer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CaffeineManager } from "./src/caffeine.ts";
import { loadConfig } from "./src/config.ts";

export interface CaffeineExtension {
	manager: CaffeineManager;
}

/** Wire the extension. The factory starts no process and no timer. */
export function createCaffeineExtension(pi: ExtensionAPI): CaffeineExtension {
	// pi.getSettings() is an action method: it is not available during
	// extension loading. Read the config lazily on first use instead.
	let manager: CaffeineManager | null = null;
	const getManager = (): CaffeineManager => (manager ??= new CaffeineManager({ config: loadConfig(pi.getSettings()) }));

	const acquire = (_event: unknown, ctx: ExtensionContext) => getManager().acquire(ctx);
	const release = (_event: unknown, ctx: ExtensionContext) => getManager().release(ctx);

	pi.on("agent_start", acquire);
	pi.on("agent_settled", release);
	pi.on("session_shutdown", release);

	pi.registerCommand("caffeine", {
		description: "Show the wake-assertion state (platform, holder pid, elapsed)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(getManager().describe(), "info");
		},
	});

	return { get manager() { return getManager(); } };
}

export default function (pi: ExtensionAPI): void {
	createCaffeineExtension(pi);
}
