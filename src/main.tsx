import { createRoot } from "react-dom/client";
import OBR from "@owlbear-rodeo/sdk";
import App from "./App";

OBR.onReady(() => {
  const root = createRoot(document.getElementById("root")!);
  root.render(<App />);
});
