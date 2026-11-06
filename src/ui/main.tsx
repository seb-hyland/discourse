import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Start } from "./Start.tsx";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./theme.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Without a folder, this is the start window. */}
    {new URLSearchParams(location.search).has("folder") ? <App /> : <Start />}
  </StrictMode>,
);
