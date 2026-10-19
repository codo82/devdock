// Strumenti esterni disponibili (ssh, autossh, pm2, ...)
const { spawnSync } = require('child_process');

function hasCommand(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(finder, [cmd], { stdio: 'ignore' }).status === 0;
}

function detectTools() {
  return {
    ssh:     hasCommand('ssh'),
    autossh: hasCommand('autossh'),
    git:     hasCommand('git'),
    npm:     hasCommand('npm'),
    pm2:     hasCommand('pm2'),
    lsof:    hasCommand('lsof'),
    ss:      process.platform === 'linux' && hasCommand('ss'),
  };
}

let tools = detectTools();

const getTools = () => tools;
const refreshTools = () => (tools = detectTools());

module.exports = { hasCommand, getTools, refreshTools };
