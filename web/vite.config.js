import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Адрес, по которому лежит приложение. На своём домене это "/", на
  // GitHub Pages — папка репозитория. Задаётся при сборке: BASE=/habez-gips/
  base: process.env.BASE || "/",
  plugins: [react()],
  server: {
    port: 5173,
    // Каталог и API живут на одном origin — cookie корзины и refresh-токена
    // работают без настройки CORS и SameSite=None.
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
      "/uploads": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // Библиотека меняется реже кода — отдельный чанк переживает выкладки
        // в кеше браузера и экономит трафик на телефоне.
        manualChunks: { vendor: ["react", "react-dom", "react-router-dom"] },
      },
    },
  },
});
