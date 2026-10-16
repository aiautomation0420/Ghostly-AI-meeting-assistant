// Launches Electron with a clean env. VS Code's integrated terminal sets
// ELECTRON_RUN_AS_NODE=1, which makes Electron behave like plain Node.
const { spawn } = require('child_process');
const electron = require('electron'); // resolves to the binary path under Node

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
