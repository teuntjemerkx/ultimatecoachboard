import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/barlow-condensed/800.css";
import "@fontsource/bebas-neue/400.css";
import { App } from "./app/App";
import { startUpdates } from "./app/updates";
import { persist } from "./app/store/db";

startUpdates();
// The installed app asks to keep its data for good (Safari can clear a website's data after 7 days unused).
if (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone) void persist();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
