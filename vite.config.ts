import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import type { Plugin } from 'vite'

/** Stamps a unique build id into dist/sw.js so each deploy invalidates the previous SW cache. */
function swBuildId(): Plugin {
  let outDir = 'dist'
  return {
    name: 'sw-build-id',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir) },
    closeBundle() {
      const file = path.join(outDir, 'sw.js')
      if (!fs.existsSync(file)) return
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('__BUILD_ID__', Date.now().toString(36)))
    },
  }
}

export default defineConfig({
  // Relative base so the build works from any subpath (GitHub Pages project sites) or a custom domain
  base: './',
  plugins: [react(), swBuildId()],
  resolve: {
    alias: {
      lamejs: path.resolve(__dirname, 'node_modules/lamejs/lame.min.js'),
    },
  },
  build: {
    target: 'es2023',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/zustand/') ||
            id.includes('node_modules/immer/')
          ) {
            return 'vendor'
          }
        },
      },
    },
  },
})
