import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import type { Server as HttpProxy } from 'http-proxy';
import basicSsl from '@vitejs/plugin-basic-ssl';

const backendTarget = process.env.VITE_BACKEND_TARGET || 'https://localhost:7860';

// Attach error handlers so proxy failures don't crash Vite's dev server / HMR
function withProxyErrorHandler(opts: ProxyOptions): ProxyOptions {
  return {
    ...opts,
    configure: (proxy: HttpProxy) => {
      proxy.on('error', (err: NodeJS.ErrnoException, _req, res) => {
        // eslint-disable-next-line no-console
        console.warn(`[proxy] ${err.code}: ${err.message}`);
        if (res && 'writeHead' in res && !(res as any).headersSent) {
          (res as any).writeHead(502, { 'Content-Type': 'text/plain' });
          (res as any).end('Bad Gateway');
        }
      });
      proxy.on('proxyReqWs', (_proxyReq: any, _req: any, socket: any) => {
        socket.on('error', (err: NodeJS.ErrnoException) => {
          // eslint-disable-next-line no-console
          console.warn(`[ws proxy] ${err.code}: ${err.message}`);
        });
      });
    },
  };
}

const httpProxy = (target: string): ProxyOptions =>
  withProxyErrorHandler({ target, secure: false });

const wsProxy = (target: string): ProxyOptions =>
  withProxyErrorHandler({ target, ws: true, secure: false });

export default defineConfig({
  plugins: [basicSsl()],
  root: '.',
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['**/e2e/**', '**/.worktrees/**', '**/node_modules/**'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    hmr: false,
    proxy: {
      '/ws':            wsProxy(backendTarget),
      '/api':           httpProxy(backendTarget),
      '/adapter':       httpProxy(backendTarget),
      '/auth':          httpProxy(backendTarget),
      '/avatars':       httpProxy(backendTarget),
      '/config':        httpProxy(backendTarget),
      '/debug_log':     httpProxy(backendTarget),
      '/health':        httpProxy(backendTarget),
      '/history':       httpProxy(backendTarget),
      '/instances':     httpProxy(backendTarget),
      '/media':         httpProxy(backendTarget),
      '/ops':           httpProxy(backendTarget),
      '/preview_voice': httpProxy(backendTarget),
      '/pv-device':     httpProxy(backendTarget),
      '/sessions':      httpProxy(backendTarget),
      '/setup':         httpProxy(backendTarget),
      '/slots':         httpProxy(backendTarget),
      '/speech-config': httpProxy(backendTarget),
      '/static':        httpProxy(backendTarget),
      '/speech-token':  httpProxy(backendTarget),
      '/stt-config':    httpProxy(backendTarget),
      '/tts':           httpProxy(backendTarget),
      '/voices':        httpProxy(backendTarget),
      '/wakeword':      httpProxy(backendTarget),
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'static',
},
});
