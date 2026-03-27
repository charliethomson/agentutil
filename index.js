#!/usr/bin/env node

'use strict';

const readline = require('readline');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Core utilities
// ---------------------------------------------------------------------------

function parseRepo(input) {
  input = input.trim();

  const urlMatch = input.match(
    /^https?:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)\/?$/
  );
  if (urlMatch) return { owner: urlMatch.groups.owner, repo: urlMatch.groups.repo };

  const shortMatch = input.match(/^(?<owner>[^/]+)\/(?<repo>[^/]+)$/);
  if (shortMatch) return { owner: shortMatch.groups.owner, repo: shortMatch.groups.repo };

  throw new Error(`Cannot parse repo from: "${input}". Use "owner/repo" or a GitHub URL.`);
}

/**
 * Spawn a child process and return a promise.
 * Accepts an optional `input` string which is written to the child's stdin.
 * All other opts are passed directly to spawn().
 */
function spawnAsync(cmd, args = [], opts = {}) {
  const { input, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, spawnOpts);
    let stdout = '';
    let stderr = '';

    if (proc.stdout) proc.stdout.on('data', d => { stdout += d; });
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d; });

    if (input !== undefined && proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }

    proc.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`${cmd} exited ${code}:\n${stderr.trim() || stdout.trim() || '(no output)'}`));
      }
    });

    proc.on('error', err => reject(new Error(`Failed to start ${cmd}: ${err.message}`)));
  });
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// GitHub API helpers (via gh CLI)
// ---------------------------------------------------------------------------

async function getRunnerVersion() {
  const { stdout } = await spawnAsync(
    'gh',
    ['api', 'repos/actions/runner/releases/latest', '--jq', '.tag_name'],
    { stdio: ['inherit', 'pipe', 'pipe'] }
  );
  return stdout.trim().replace(/^v/, '');
}

async function getRegistrationToken(owner, repo) {
  const { stdout } = await spawnAsync(
    'gh',
    [
      'api',
      '--method', 'POST',
      `repos/${owner}/${repo}/actions/runners/registration-token`,
      '--jq', '.token',
    ],
    { stdio: ['inherit', 'pipe', 'pipe'] }
  );
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Remote script builder
// ---------------------------------------------------------------------------

function buildRemoteScript(owner, repo, token, version, runnerConfig) {
  const { installDir, namePrefix, labels, runAsService, serviceUser } = runnerConfig;
  const repoInstallDir = `${installDir}/${repo}`;
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const labelsStr = labels.join(',');
  const svcUserFlag = serviceUser ?? '';

  const serviceBlock = runAsService
    ? `
echo "[runner-setup] Installing and starting service ..."
sudo ./svc.sh stop 2>/dev/null || true
sudo ./svc.sh install ${svcUserFlag}
sudo ./svc.sh start
echo "[runner-setup] Service started."
`.trim()
    : 'echo "[runner-setup] Skipping service install (runAsService=false)."';

  return `
set -euo pipefail

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  RUNNER_ARCH="x64" ;;
  aarch64) RUNNER_ARCH="arm64" ;;
  armv7l)  RUNNER_ARCH="arm" ;;
  *)        echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
RUNNER_FILENAME="actions-runner-\${OS}-\${RUNNER_ARCH}-${version}.tar.gz"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${version}/\${RUNNER_FILENAME}"

RUNNER_NAME="${namePrefix}-$(hostname -s)"
INSTALL_DIR="${repoInstallDir}"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "[runner-setup] Downloading \$RUNNER_URL ..."
curl -fsSL "$RUNNER_URL" -o runner.tar.gz

echo "[runner-setup] Extracting ..."
tar xzf runner.tar.gz
rm runner.tar.gz

if [ -f .runner ]; then
  echo "[runner-setup] Existing runner found — removing before reconfigure ..."
  sudo ./svc.sh stop 2>/dev/null || true
  sudo ./svc.sh uninstall 2>/dev/null || true
  rm -f .runner .credentials .credentials_rsaparams
fi

echo "[runner-setup] Configuring runner: \$RUNNER_NAME ..."
./config.sh \\
  --url "${repoUrl}" \\
  --token "${token}" \\
  --name "\$RUNNER_NAME" \\
  --labels "${labelsStr}" \\
  --unattended \\
  --replace

${serviceUser ? `echo "[runner-setup] Setting ownership to ${serviceUser} ..."
sudo chown -R ${serviceUser}:${serviceUser} "$INSTALL_DIR"` : ''}

${serviceBlock}

echo "[runner-setup] Done on $(hostname)."
`.trim();
}

// ---------------------------------------------------------------------------
// Per-host runner installation
// ---------------------------------------------------------------------------

async function runOnHost(host, owner, repo, version, config) {
  console.log(`\n==> [${host}] Generating registration token ...`);
  const token = await getRegistrationToken(owner, repo);

  const script = buildRemoteScript(owner, repo, token, version, config.runner);

  console.log(`==> [${host}] Connecting via SSH ...`);
  await spawnAsync(
    'ssh',
    [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=15',
      host,
      'bash -s',
    ],
    {
      input: script,
      stdio: ['pipe', 'inherit', 'inherit'],
    }
  );

  console.log(`==> [${host}] Setup complete.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const configPath = path.join(path.dirname(process.argv[1]), 'config.json');

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to load config.json: ${err.message}`);
  }

  if (!Array.isArray(config.hosts) || config.hosts.length === 0) {
    throw new Error('config.json must have a non-empty "hosts" array');
  }

  const repoInput = await prompt('GitHub repo (owner/repo or URL): ');
  const { owner, repo } = parseRepo(repoInput);

  console.log(`\nRepo:  ${owner}/${repo}`);
  console.log(`Hosts: ${config.hosts.join(', ')}`);

  console.log('\nFetching latest GitHub Actions runner version ...');
  const version = await getRunnerVersion();
  console.log(`Runner version: ${version}`);

  const errors = [];

  for (const host of config.hosts) {
    try {
      await runOnHost(host, owner, repo, version, config);
    } catch (err) {
      console.error(`\n[ERROR] Failed on ${host}: ${err.message}`);
      errors.push({ host, error: err.message });
    }
  }

  console.log('');
  if (errors.length === 0) {
    console.log(`All ${config.hosts.length} host(s) configured successfully.`);
  } else {
    console.log(`Completed with ${errors.length} failure(s):`);
    for (const { host, error } of errors) {
      console.log(`  - ${host}: ${error}`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
