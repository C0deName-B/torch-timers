import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Replace REPO_NAME with your repo's name
export default defineConfig({
  plugins: [react()],
  base: "torch-timers/",
});
