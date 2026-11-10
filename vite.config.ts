import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths so the build works under https://<user>.github.io/<repo>/ (routing is hash-based).
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
