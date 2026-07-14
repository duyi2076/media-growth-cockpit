import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { WorkbenchIndexProvider } from "./data/adapter";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <WorkbenchIndexProvider>
        <App />
      </WorkbenchIndexProvider>
    </BrowserRouter>
  </StrictMode>
);
