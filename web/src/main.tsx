import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Web3Provider from "./components/providers/Web3Provider";
import { initApiBase } from "./lib/api-base";
import "./index.css";

void initApiBase().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Web3Provider>
        <App />
      </Web3Provider>
    </StrictMode>
  );
});
