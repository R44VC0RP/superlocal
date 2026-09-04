import React from "react";
import { createRoot } from "react-dom/client";
import ApplicationGate from "./ApplicationGate";
import { startBrowserLogCapture } from "./browser-logs";
import "./style.css";

startBrowserLogCapture();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApplicationGate />
  </React.StrictMode>,
);
