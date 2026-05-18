import 'dotenv/config';
import { defineConfig } from 'vite';

const backendPort = process.env.BACKEND_PORT || '8787';
const backendTarget = `http://127.0.0.1:${backendPort}`;
const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://cdn.plaid.com",
    "connect-src 'self' https://*.plaid.com",
    "frame-src https://*.plaid.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function apiProxy() {
  return {
    target: backendTarget,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq) => {
        if (process.env.LOCAL_API_TOKEN) {
          proxyReq.setHeader('Authorization', 'Bearer ' + process.env.LOCAL_API_TOKEN);
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    headers: securityHeaders,
    proxy: {
      '/api': apiProxy(),
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    headers: securityHeaders,
    proxy: {
      '/api': apiProxy(),
    },
  },
});
