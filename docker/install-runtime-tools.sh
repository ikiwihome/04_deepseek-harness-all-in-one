#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ffmpeg python3-venv python3-pip python-is-python3

# Use a writable virtual environment instead of modifying Debian's system Python.
python3 -m venv /opt/dsh-tools/venv
version="${PLAYWRIGHT_VERSION:-latest}"
if [ "$version" = latest ]; then
  /opt/dsh-tools/venv/bin/python -m pip install --no-cache-dir playwright
else
  /opt/dsh-tools/venv/bin/python -m pip install --no-cache-dir "playwright==$version"
fi

# Match both language bindings to the same release and browser revision.
version="$(/opt/dsh-tools/venv/bin/python -c 'from importlib.metadata import version; print(version("playwright"))')"
npm install --prefix /opt/dsh-tools --no-audit --no-fund "playwright@$version"
/opt/dsh-tools/node_modules/.bin/playwright install --with-deps chromium
browser="$(node -e 'console.log(require("/opt/dsh-tools/node_modules/playwright").chromium.executablePath())')"
test -x "$browser"
ln -s "$browser" /usr/local/bin/chromium

# Browser binaries must be shared across root, node and HOME=/workspace.
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
chown -R node:node /opt/dsh-tools
rm -rf /var/lib/apt/lists/*
