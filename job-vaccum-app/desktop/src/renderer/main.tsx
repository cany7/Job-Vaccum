import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyAppearance, readPrefs } from "./prefs";
import "./styles.css";

// Resolve the saved theme before the first paint.
applyAppearance(readPrefs());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
