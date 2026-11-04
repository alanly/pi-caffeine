/**
 * Footer status line. One pure function maps the manager state to the
 * setStatus value, so the footer and the state stay in sync by construction.
 */

import type { CaffeineState } from "./types.ts";

/** The setStatus key. Namespaced to this extension. */
export const STATUS_KEY = "caffeine";

/**
 * The status value shown while a wake assertion is held, or undefined to
 * clear the status entry.
 */
export function formatStatus(state: CaffeineState, symbol: string): string | undefined {
	return state.holder === null ? undefined : symbol;
}
