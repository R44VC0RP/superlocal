import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig(() => {
  const target = process.env.SUPERLOCAL_API_ORIGIN || process.env.SUPERLOCAL_INBOX_URL || 'http://127.0.0.1:8790'
  const webHost = process.env.SUPERLOCAL_WEB_ORIGIN ? new URL(process.env.SUPERLOCAL_WEB_ORIGIN).hostname : 'localhost'
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1', port: Number(process.env.SUPERLOCAL_WEB_PORT || 5178), strictPort: true,
      allowedHosts: ['super.local', webHost],
      fs: { deny: [
        '.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/superlocal.local.json', '**/*.sqlite', '**/*.sqlite-*', '**/data/**',
        ...(process.env.SUPERLOCAL_CONFIG ? [resolve(process.env.SUPERLOCAL_CONFIG).replaceAll('\\', '/')] : []),
      ] },
      proxy: {
        '/v1': { target, changeOrigin: true },
        '/host': { target, changeOrigin: true },
        '/session': {
          target, changeOrigin: true,
          rewrite: () => process.env.SUPERLOCAL_SESSION_PATH || '/session',
        },
      },
    },
  }
})
