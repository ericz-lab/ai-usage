import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";

// `?theme=light|dark` (ai-space passes the viewer's theme to embedded pages) beats the OS setting.
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

createRoot(document.getElementById("root")!).render(<App />);
