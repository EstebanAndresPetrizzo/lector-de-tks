#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi

if [ ! -f .venv/.dependencias-instaladas ]; then
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install --only-binary=:all: -r requirements.txt
  touch .venv/.dependencias-instaladas
fi

exec .venv/bin/python app.py
