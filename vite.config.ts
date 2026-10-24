import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "web",
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
	server: {
		port: 5173,
		proxy: { "/ws": { target: "ws://127.0.0.1:4848", ws: true } },
	},
});
