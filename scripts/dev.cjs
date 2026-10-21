// Arranca Vite y, cuando responde, Electron apuntando al servidor de desarrollo.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const bin = (n) => path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? `${n}.cmd` : n);
const vite = spawn(bin('vite'), [], { stdio: 'inherit', shell: true });

const waitPort = (port) =>
  new Promise((resolve) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1', () => (s.end(), resolve()));
      s.on('error', () => setTimeout(tryOnce, 300));
    };
    tryOnce();
  });

waitPort(5173).then(() => {
  const electron = spawn(require('electron'), ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:5173' },
  });
  electron.on('exit', (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
});
