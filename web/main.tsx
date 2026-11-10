import { createRoot } from "react-dom/client";
import App from "./App.tsx";

// Theme and language are applied before first paint by the inline script in index.html
// (`?theme=` / `?lang=`, then the saved choice, then the system); the stylesheet is linked there.
createRoot(document.getElementById("root")!).render(<App />);
