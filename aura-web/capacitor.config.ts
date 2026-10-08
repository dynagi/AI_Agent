import type { CapacitorConfig } from '@capacitor/cli';

// The app is served from https://localhost inside the WebView. A local dev backend on plain HTTP
// (VITE_API_URL=http://<PC Wi-Fi IP>:4000) counts as mixed content and is blocked unless this is on.
// Set it only for dev builds: `AURA_DEV_HTTP=1 npx cap sync android`. Release builds use an HTTPS backend.
const devHttp = process.env.AURA_DEV_HTTP === '1';

const config: CapacitorConfig = {
  appId: 'com.aura.app',
  appName: 'AURA',
  webDir: 'dist',
  android: { allowMixedContent: devHttp },
};

export default config;
