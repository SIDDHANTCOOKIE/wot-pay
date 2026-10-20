import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Mint fixtures run real blind-signature and DLEQ cryptography.
  test: { include: ['src/**/*.test.js'], testTimeout: 20000 },
})
