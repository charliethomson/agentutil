# agentutil

Provision GitHub Actions self-hosted runners to remote machines over SSH.

## Prerequisites

- [Node.js](https://nodejs.org) (or Bun)
- [`gh`](https://cli.github.com) CLI, authenticated (`gh auth login`)
- SSH key access to target hosts

## Setup

### 1. Prepare each remote host

Run this once on every machine you want to use as a runner target. Replace `<ssh-user>` with the user you SSH in as (e.g. `c`).

**curl:**
```sh
curl -fsSL https://raw.githubusercontent.com/charliethomson/agentutil/main/setup-agent.sh | sudo bash -s <ssh-user>
```

**wget:**
```sh
wget -qO- https://raw.githubusercontent.com/charliethomson/agentutil/main/setup-agent.sh | sudo bash -s <ssh-user>
```

This will:
- Create a `github-runner` service user that the runner daemon runs as
- Create `/opt/actions-runner` owned by your SSH user
- Write `/etc/sudoers.d/actions-runner` granting passwordless sudo only for `svc.sh`

### 2. Configure targets

Edit `config.json`:

```json
{
  "hosts": ["<ssh-user>@<host>"],
  "runner": {
    "installDir": "/opt/actions-runner",
    "namePrefix": "self-hosted",
    "labels": ["self-hosted", "linux", "x64"],
    "runAsService": true,
    "serviceUser": "github-runner"
  }
}
```

### 3. Install runners

```sh
node index.js
```

You'll be prompted for a GitHub repo (`owner/repo` or a full GitHub URL). The script will generate a registration token and install a runner on each host.

Runners are installed into `<installDir>/<repo>`, so multiple repos can coexist on the same host.
