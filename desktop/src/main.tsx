import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// The benchmark is compiled only in the special CI preview and starts only
// with a separate, explicit Windows runner opt-in. It never runs for users.
if (import.meta.env.VITE_C2C_CI_PERF === "1") {
  window.setTimeout(() => {
    void import("./ci-perf-probe").then(probe => probe.runCiPerfProbe());
  }, 2000);
}
