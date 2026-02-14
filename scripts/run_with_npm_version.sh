#!/usr/bin/env bash
set -e

if [ "$CI" = "true" ]; then
  echo "CI environment detected — skipping nvm"
  exec "$@"
fi

if [ -z "$NVM_DIR" ]; then
  export NVM_DIR="$HOME/.nvm"
fi

if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"

  if [ -f ".nvmrc" ]; then
    echo "Using Node version from .nvmrc via nvm"
    nvm use > /dev/null
  fi
else
  echo "nvm not found, skipping Node version switch"
fi

exec "$@"
