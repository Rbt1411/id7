#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node 2>/dev/null)"
[ -n "$NODE" ] || NODE=/usr/bin/node
exec "$NODE" "$DIR/smartx-testd.js"
