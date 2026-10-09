#!/usr/bin/env bash
# Build, install and launch the ExamCompanion iOS app on a connected iPhone.
#
# Usage:
#   npm run ios:device
#   bash scripts/ios-device-run.sh [coredevice-id-or-udid]
#
# Environment:
#   IOS_TEAM_ID        Apple development team (default: ZFC558KX53, the owner's Personal Team)
#   IOS_BUNDLE_ID      Bundle identifier (default: com.djhizon.examcompanion). Judges signing with
#                      their own free Apple ID must pick their own, e.g. com.<you>.examcompanion
#   IOS_DEVICE         devicectl identifier or hardware UDID (default: first connected physical iOS device)
#   IOS_CONFIGURATION  Xcode configuration (default: Debug)
#   IOS_DERIVED_DATA   DerivedData path (default: apps/ios/DerivedData, git-ignored)
#
# Requires Xcode 15+ (xcrun devicectl) and xcodegen. The phone must be trusted,
# have Developer Mode on, and be unlocked for the launch step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$ROOT/apps/ios"
SCHEME="ExamCompanion"
BUNDLE_ID="${IOS_BUNDLE_ID:-com.djhizon.examcompanion}"
TEAM_ID="${IOS_TEAM_ID:-ZFC558KX53}"
CONFIGURATION="${IOS_CONFIGURATION:-Debug}"
DERIVED_DATA="${IOS_DERIVED_DATA:-$IOS_DIR/DerivedData}"
WANTED="${1:-${IOS_DEVICE:-}}"

die() {
  echo "ios-device-run: $*" >&2
  exit 1
}

command -v xcodegen >/dev/null 2>&1 || die "xcodegen not found (brew install xcodegen)"
command -v python3 >/dev/null 2>&1 || die "python3 not found (install Xcode command line tools)"
xcrun --find devicectl >/dev/null 2>&1 || die "xcrun devicectl not found (Xcode 15+ required)"

# Resolve the device: devicectl needs its CoreDevice identifier, xcodebuild needs the hardware UDID.
DEVICES_JSON="$(mktemp -t ios-devices).json"
trap 'rm -f "$DEVICES_JSON"' EXIT
xcrun devicectl list devices --json-output "$DEVICES_JSON" >/dev/null 2>&1 ||
  die "xcrun devicectl list devices failed"

# (Heredoc read into a variable: macOS bash 3.2 mis-parses heredocs nested in $(...).)
PICK_DEVICE_PY=""
read -r -d '' PICK_DEVICE_PY <<'PY' || true
import json, sys
path, wanted = sys.argv[1], sys.argv[2].strip()
devices = json.load(open(path)).get("result", {}).get("devices", [])
picked = None
for d in devices:
    hw = d.get("hardwareProperties", {})
    conn = d.get("connectionProperties", {})
    if hw.get("platform") != "iOS" or hw.get("reality") != "physical":
        continue
    ids = {d.get("identifier", ""), hw.get("udid", "")}
    if wanted:
        if wanted in ids:
            picked = d
            break
    elif conn.get("tunnelState") == "connected" or conn.get("pairingState") == "paired":
        if picked is None or conn.get("tunnelState") == "connected":
            picked = d
        if conn.get("tunnelState") == "connected":
            break
if picked is None:
    sys.exit(0)
name = picked.get("deviceProperties", {}).get("name", "iPhone").replace(" ", "_")
print(picked.get("identifier", ""), picked.get("hardwareProperties", {}).get("udid", ""), name)
PY

CORE_ID=""
HW_UDID=""
DEVICE_NAME=""
PICKED="$(python3 -c "$PICK_DEVICE_PY" "$DEVICES_JSON" "$WANTED")" || die "could not parse devicectl output"
if [ -n "$PICKED" ]; then
  read -r CORE_ID HW_UDID DEVICE_NAME <<<"$PICKED"
fi

[ -n "${CORE_ID:-}" ] && [ -n "${HW_UDID:-}" ] ||
  die "no connected physical iOS device found${WANTED:+ matching '$WANTED'}. Plug in the iPhone, unlock it, trust this Mac, and enable Developer Mode."

echo "==> Device: $DEVICE_NAME (devicectl $CORE_ID, udid $HW_UDID)"
echo "==> Team: $TEAM_ID  Configuration: $CONFIGURATION"

echo "==> Regenerating Xcode project"
(cd "$IOS_DIR" && xcodegen generate --quiet)

echo "==> Building for device"
xcodebuild \
  -project "$IOS_DIR/ExamCompanion.xcodeproj" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "id=$HW_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  build -quiet

APP="$DERIVED_DATA/Build/Products/$CONFIGURATION-iphoneos/$SCHEME.app"
[ -d "$APP" ] || die "built app not found at $APP"

echo "==> Installing $APP"
xcrun devicectl device install app --device "$CORE_ID" "$APP"

echo "==> Launching $BUNDLE_ID"
if ! xcrun devicectl device process launch --device "$CORE_ID" --terminate-existing "$BUNDLE_ID"; then
  echo "ios-device-run: launch failed. If the phone is locked, unlock it and run:" >&2
  echo "  xcrun devicectl device process launch --device $CORE_ID --terminate-existing $BUNDLE_ID" >&2
  echo "If iOS reports an untrusted developer, open Settings > General > VPN & Device Management and trust the profile." >&2
  exit 1
fi
echo "==> Done"
