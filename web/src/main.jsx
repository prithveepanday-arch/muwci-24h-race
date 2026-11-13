import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { start } from "./store.js";
import { Home, TeamPage } from "./public.jsx";
import { TV } from "./tv.jsx";
import { Admin } from "./admin.jsx";
import { DialogProvider, useRoute } from "./ui.jsx";

function App() {
  const path = useRoute().replace(/\/+$/, "") || "/";
  if (path === "/tv") return <TV />;
  if (path.startsWith("/team/")) return <TeamPage teamId={decodeURIComponent(path.slice(6))} />;
  if (path === "/admin" || path.startsWith("/admin/")) return <Admin section={path.slice(7)} />;
  return <Home />;
}

start();
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <DialogProvider>
      <App />
    </DialogProvider>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Offline mode unavailable:", error));
  });
}
// Ask the browser not to evict race data under storage pressure.
navigator.storage?.persist?.().catch(() => {});
