import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ApprovalWindow } from "@/features/projects/approval-window";
import { ThemeProvider } from "@/components/theme-provider";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      {new URLSearchParams(window.location.search).get("view") ===
      "approval" ? (
        <ApprovalWindow />
      ) : (
        <App />
      )}
    </ThemeProvider>
  </React.StrictMode>,
);
