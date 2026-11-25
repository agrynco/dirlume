#!/usr/bin/env bash
set -euo pipefail

if [[ -f .runner ]]; then
    echo 'This runner volume is already registered.' >&2
    exit 1
fi
if [[ "${1:-}" != https://github.com/*/* ]]; then
    echo 'Pass the private GitHub repository URL as the first argument.' >&2
    exit 1
fi

read -rsp 'GitHub runner registration token: ' token
echo
./config.sh --unattended --url "$1" --token "$token" --name dirlume-linux-x64 --labels dirlume-linux-x64
