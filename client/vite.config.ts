import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    fs: {
      // allow importing ../../shared from outside client root
      allow: [".."],
    },
  },
  preview: {
    host: true,
  },
});
