import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startBrowserLogCapture } from "./browser-logs";
import "./style.css";

startBrowserLogCapture();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
