import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import mkcert from 'vite-plugin-mkcert'

export default defineConfig({
  plugins: [react(), mkcert()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true, // Expose to all network interfaces
    https: {
      key: './cert/key.pem',
      cert: './cert/cert.pem',
    },
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'https://guffgaff1.up.railway.app',
        changeOrigin: true,
        secure: false,
        ws: true
      }
    }
  }
})

