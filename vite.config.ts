import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  const localConnectDir = path.resolve(__dirname, 'local-connect');
  const distDir = path.resolve(__dirname, 'dist');

  return {
    root: localConnectDir,
    build: {
      outDir: distDir,
      emptyOutDir: true,
    },
    plugins: [
      {
        name: 'copy-local-connect-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const filesToCopy = ['style.css', 'app.js', 'webrtc.js', 'qr.js', 'README.md'];
          for (const file of filesToCopy) {
            const src = path.join(localConnectDir, file);
            const dest = path.join(distDir, file);
            if (fs.existsSync(src)) {
              fs.copyFileSync(src, dest);
            }
          }
          const srcLibs = path.join(localConnectDir, 'libs');
          const destLibs = path.join(distDir, 'libs');
          if (fs.existsSync(srcLibs)) {
            fs.cpSync(srcLibs, destLibs, {recursive: true, force: true});
          }
        },
      },
    ],
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
