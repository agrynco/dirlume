#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

verify_app() {
  codesign --verify --deep --strict --verbose=2 "$1"
  xcrun stapler validate "$1"
  syspolicy_check distribution "$1"
}

case "${1:-}" in
  bundle)
    shift
    for secret in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_P8; do
      if [[ -z "${!secret:-}" ]]; then
        echo "::error::Configure the $secret Actions secret to publish macOS releases."
        exit 1
      fi
    done

    umask 077
    scratch=$(mktemp -d "${RUNNER_TEMP}/dirlume-notary.XXXXXX")
    export APPLE_API_KEY_PATH="$scratch/AuthKey.p8"
    trap 'rm -f "$APPLE_API_KEY_PATH"; rmdir "$scratch"' EXIT
    printf '%s\n' "$APPLE_API_KEY_P8" > "$APPLE_API_KEY_PATH"
    unset APPLE_API_KEY_P8
    umask 022

    # Tauri signs the app and DMG, then includes the stapled app in its updater archive.
    npm run tauri -- "$@"
    unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

    dmg=(src-tauri/target/release/bundle/dmg/*.dmg)
    if [[ ${#dmg[@]} -ne 1 ]]; then
      echo '::error::Expected exactly one macOS disk image from Tauri.'
      exit 1
    fi
    auth=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
    if ! result=$(xcrun notarytool submit "${dmg[0]}" "${auth[@]}" --wait --timeout 40m --output-format json) ||
      ! jq -e '.status == "Accepted"' <<< "$result" >/dev/null; then
      printf '%s\n' "$result" >&2
      id=$(jq -r '.id // empty' <<< "$result" || true)
      if [[ -n "$id" ]]; then
        xcrun notarytool log "$id" "${auth[@]}" >&2 || true
      fi
      echo '::error::Apple did not accept notarization of the macOS disk image.'
      exit 1
    fi
    xcrun stapler staple "${dmg[0]}"
    ;;
  verify)
    dmg=(release/*.dmg)
    portable=(release/*-portable.zip)
    updater=(release/*.app.tar.gz)
    if [[ ${#dmg[@]} -ne 1 || ${#portable[@]} -ne 1 || ${#updater[@]} -ne 1 ]]; then
      echo '::error::Expected one DMG, one portable ZIP, and one updater archive per macOS runner.'
      exit 1
    fi

    codesign --verify --strict --verbose=2 "${dmg[0]}"
    xcrun stapler validate "${dmg[0]}"
    scratch=$(mktemp -d "${RUNNER_TEMP}/dirlume-verify.XXXXXX")
    trap 'rm -rf -- "$scratch"' EXIT
    ditto -x -k "${portable[0]}" "$scratch/portable"
    verify_app "$scratch/portable/Dirlume.app"
    mkdir "$scratch/updater"
    tar -xzf "${updater[0]}" -C "$scratch/updater"
    verify_app "$scratch/updater/Dirlume.app"
    ;;
  *)
    echo 'Usage: macos-release.sh bundle <tauri build arguments> | verify' >&2
    exit 1
    ;;
esac
