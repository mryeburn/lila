#!/bin/bash
# Double-click this file on a Mac to start Pi Learn.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Get it from https://nodejs.org (the LTS version), then double-click this file again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing Pi Learn (this takes a minute)..."
  npm install || { read -n 1 -s -r -p "Install failed. Press any key to close."; exit 1; }
fi
npm start
