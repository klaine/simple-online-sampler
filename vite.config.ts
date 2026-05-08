import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      lamejs: path.resolve(__dirname, 'node_modules/lamejs/lame.min.js'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor'
          }
          if (id.includes('node_modules/zustand/') || id.includes('node_modules/immer/')) {
            return 'audio'
          }
        },
      },
    },
  },
})
