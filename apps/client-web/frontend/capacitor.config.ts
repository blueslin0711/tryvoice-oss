import type { CapacitorConfig } from '@capacitor/cli';

const isDev = process.env.CAPACITOR_MODE !== 'production';

const config: CapacitorConfig = {
  appId: 'com.tryvoice.app',
  appName: 'TryVoice',
  webDir: 'dist',
  server: {
    // Dev: load from Vite dev server (hot reload)
    // Production: comment out 'url' and run `npm run cap:build`
    ...(isDev && { url: 'https://100.126.70.43:5173' }),
    iosScheme: 'https',
  },
};

export default config;
