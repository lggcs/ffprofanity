import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync, existsSync } from "fs";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
        options: resolve(__dirname, "src/options/index.ts"),
        popup: resolve(__dirname, "src/popup/index.ts"),
        "page-scripts/plutotv": resolve(
          __dirname,
          "src/page-scripts/plutotv-injected.ts",
        ),
        "page-scripts/youtube": resolve(
          __dirname,
          "src/page-scripts/youtube-injected.ts",
        ),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name.startsWith("page-scripts/")) {
            return "[name].js";
          }
          return "[name].js";
        },
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  plugins: [
    {
      name: "copy-manifest-and-html",
      closeBundle() {
        // Ensure dist directory exists
        if (!existsSync("dist")) {
          mkdirSync("dist", { recursive: true });
        }
        if (!existsSync("dist/icons")) {
          mkdirSync("dist/icons", { recursive: true });
        }
        if (!existsSync("dist/page-scripts")) {
          mkdirSync("dist/page-scripts", { recursive: true });
        }

        // Copy manifest.json
        copyFileSync("public/manifest.json", "dist/manifest.json");

        // Copy HTML files
        copyFileSync("src/options/options.html", "dist/options.html");
        copyFileSync("src/popup/popup.html", "dist/popup.html");

        // Copy CSS
        copyFileSync("src/styles/options.css", "dist/options.css");
        copyFileSync("src/styles/popup.css", "dist/popup.css");

        // Copy icons (will need placeholder)
        if (existsSync("public/icons")) {
          const iconFiles = [
            "icon-16.png",
            "icon-32.png",
            "icon-48.png",
            "icon-128.png",
          ];
          for (const icon of iconFiles) {
            if (existsSync(`public/icons/${icon}`)) {
              copyFileSync(`public/icons/${icon}`, `dist/icons/${icon}`);
            }
          }
        }
      },
    },
  ],
});
