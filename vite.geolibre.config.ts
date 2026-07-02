import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "geolibre-plugin/dist",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: "src/geolibre.ts",
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "style"
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.name === "style.css" ? "style.css" : "[name][extname]"
      }
    }
  }
});
