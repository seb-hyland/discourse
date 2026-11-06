import type { Bridge } from "../shared/api.ts";

/** The main process: each call is sent on the channel of its name (see preload.cjs). */
export const api = new Proxy({} as Bridge, {
    get: (_, channel: string) => (channel === "onChange" ? window.discourse.onChange : (...args: unknown[]) => window.discourse.invoke(channel, ...args)),
});
