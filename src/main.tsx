import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const failed = () =>
      window.dispatchEvent(new CustomEvent("booxs-offline-error"));
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "redundant" && !registration.active)
            failed();
        });
      })
      .catch(failed);
  });
}
