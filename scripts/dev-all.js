import net from 'node:net';
import { spawn } from 'node:child_process';

const START_PORT = Number.parseInt(process.env.FRONTEND_PORT_START || '5173', 10);
const MAX_PORT = Number.parseInt(process.env.FRONTEND_PORT_MAX || '5190', 10);
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, '127.0.0.1');
  });
}

async function pickFrontendPort() {
  for (let port = START_PORT; port <= MAX_PORT; port += 1) {
    // Pick the first available port so frontend and backend CORS can match.
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No free frontend port found between ${START_PORT} and ${MAX_PORT}.`);
}

function stopProcess(child) {
  if (child && !child.killed) {
    child.kill('SIGTERM');
  }
}

async function main() {
  const frontendPort = await pickFrontendPort();
  const frontendOrigin = `http://localhost:${frontendPort}`;

  console.log(`[dev:all] frontend port: ${frontendPort}`);
  console.log(`[dev:all] backend FRONTEND_ORIGIN: ${frontendOrigin}`);

  const backend = spawn(npmCmd, ['run', 'server'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      FRONTEND_ORIGIN: frontendOrigin,
    },
  });

  const frontend = spawn(npmCmd, ['run', 'dev', '--', '--port', String(frontendPort)], {
    stdio: 'inherit',
    env: process.env,
  });

  let shuttingDown = false;

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    stopProcess(backend);
    stopProcess(frontend);
    setTimeout(() => process.exit(exitCode), 150);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  backend.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev:all] backend exited with code ${code ?? 0}`);
      shutdown(code ?? 1);
    }
  });

  frontend.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev:all] frontend exited with code ${code ?? 0}`);
      shutdown(code ?? 1);
    }
  });
}

main().catch((err) => {
  console.error(`[dev:all] ${err.message}`);
  process.exit(1);
});
