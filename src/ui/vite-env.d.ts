/// <reference types="vite/client" />

/** From the Electron app's preload.cjs. */
interface Window {
    discourse: {
        invoke(channel: string, ...args: unknown[]): Promise<any>;
        onChange: import("../shared/api.ts").Bridge["onChange"];
    };
}
