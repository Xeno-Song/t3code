# Build and run this fork on Linux

This guide builds `main` from `Xeno-Song/t3code` on an Ubuntu/Debian desktop
and runs it from a terminal. Official installers and `npx t3@latest` use upstream
releases. Build this fork from source to use its changes.

## Initial setup and build

You need Node.js 24.x, version 24.13.1 or newer, and the Vite+ CLI, `vp`.
Install the compiler tools and libsecret headers used by the Linux desktop app:

```bash
sudo apt-get update
sudo apt-get install git curl build-essential libsecret-1-dev pkg-config
curl -fsSL https://vite.plus | bash
```

After installing `vp`, open a new terminal and run the following commands.
This guide uses `~/src/t3code` for the checkout. If you choose another location,
adjust the alias configuration below to match.

```bash
mkdir -p "$HOME/src"
git clone --branch main https://github.com/Xeno-Song/t3code.git "$HOME/src/t3code"
cd "$HOME/src/t3code"
vp env install
node --version
vp i
vp run build:desktop
```

With environment management enabled, `vp` selects Node.js and the package manager
from the repository's `package.json`. Check that `node --version` meets the
requirement above. See [Vite+ environment management](https://viteplus.dev/guide/env)
for setup details.

Once the build finishes, run the app directly. Packaging an installer is optional.
Follow the [provider setup guide](./install.md#providers) to install and authenticate
the provider you want to use.

```bash
export T3CODE_HOME="$HOME/.t3"
node apps/desktop/scripts/start-electron.mjs
```

## Data directory and aliases

Add the following to `~/.bashrc` once. Set `T3CODE_HOME` to the T3 home root;
the app appends `userdata`. In this example, conversations, settings, and onboarding
completion are stored under `~/.t3/userdata`. If you already use another T3 home,
set the variable to that location.

```bash
export T3CODE_HOME="$HOME/.t3"
export T3CODE_SOURCE_DIR="$HOME/src/t3code"

alias t3code='(cd "$T3CODE_SOURCE_DIR" && node apps/desktop/scripts/start-electron.mjs)'
alias t3code-build='(cd "$T3CODE_SOURCE_DIR" && vp run build:desktop)'
alias t3code-update='(cd "$T3CODE_SOURCE_DIR" && git pull --ff-only && vp i && vp run build:desktop)'
```

Apply the changes to your current terminal:

```bash
source "$HOME/.bashrc"
```

| Command         | Action                                                         |
| --------------- | -------------------------------------------------------------- |
| `t3code`        | Start the built desktop app                                    |
| `t3code-build`  | Rebuild the current checkout                                   |
| `t3code-update` | Pull the fork's main branch, install dependencies, and rebuild |

Each alias changes directories inside a subshell, so your terminal stays in its
current directory. For daily use, run `t3code`. Rebuild after editing or updating
the source, then close and restart the app to load the new build.

To reuse data from an installed app, select the same `T3CODE_HOME` and close the
installed app before starting this build. Use separate T3 homes if you run different
versions simultaneously. Bash configuration applies to terminal launches; launching
from an app icon requires configuring its environment separately.

`vp run dev` and `vp run dev:desktop` select development data directories.
Use `t3code` for daily use of the app built above.

## Run in a browser

Build the server and web client from the repository root, then start the server.
The same `T3CODE_HOME` configuration applies.

```bash
cd "$T3CODE_SOURCE_DIR"
vp run --filter t3 build
node apps/server/dist/bin.mjs
```

Open the address printed in the terminal. Rebuild and restart the server after
updating the source.
