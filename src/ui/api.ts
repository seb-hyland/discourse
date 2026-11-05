import type { Bridge } from "../shared/api.ts";

/** The main process, through the preload script. */
export const api: Bridge = window.discourse;
