/// <reference types="vite/client" />

/** From the Electron app's preload.cjs. */
interface Window {
  discourse: import("../shared/api.ts").Bridge;
}
