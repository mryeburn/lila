#!/bin/bash
# One-step installer for Pi Learn on a Mac or a Chromebook (or other Linux).
#
# Installs everything Pi Learn needs: its own copy of Node.js, the app itself,
# and a "Pi Learn" icon. Nothing else on the computer is changed. Safe to run
# again: it updates the app to the latest version and keeps your lessons and
# sign-ins.
#
#   curl -fsSL https://raw.githubusercontent.com/mryeburn/pi-learn-userfriendlyinterface/main/scripts/install.sh | bash

set -euo pipefail

# Everything is inside { } so bash reads the whole script before running any
# of it (it arrives through a pipe).
{

REPO="mryeburn/pi-learn-userfriendlyinterface"
TARBALL_URL="${PI_LEARN_TARBALL:-https://github.com/$REPO/archive/refs/heads/main.tar.gz}"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"
APP_DIR="$HOME/pi-learn"
DATA_DIR="$HOME/.pi-learn-web"
NODE_DIR="$DATA_DIR/node"

say() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
fail() {
	printf '\n\033[1;31mSetup stopped:\033[0m %s\n' "$*" >&2
	exit 1
}

case "$(uname -s)" in
Darwin) OS=darwin ;;
Linux) OS=linux ;;
*) fail "This installer is for Mac and Chromebook/Linux. On Windows, use install-windows.ps1." ;;
esac
case "$(uname -m)" in
arm64 | aarch64) ARCH=arm64 ;;
x86_64 | amd64) ARCH=x64 ;;
*) fail "Unsupported processor: $(uname -m)." ;;
esac

# ── 1. Basic tools (Linux only; a Mac already has them) ───────────────────────
if [ "$OS" = linux ]; then
	need_apt=()
	command -v curl >/dev/null || need_apt+=(curl)
	command -v tar >/dev/null || need_apt+=(tar)
	command -v gzip >/dev/null || need_apt+=(gzip)
	[ -e /etc/ssl/certs/ca-certificates.crt ] || need_apt+=(ca-certificates)
	if [ ${#need_apt[@]} -gt 0 ]; then
		say "Installing ${need_apt[*]} (you may be asked for your password)"
		sudo apt-get update -y
		sudo apt-get install -y "${need_apt[@]}"
	fi
fi

mkdir -p "$DATA_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# ── 2. Node.js ────────────────────────────────────────────────────────────────
# Pi Learn gets its own private copy of Node.js, so it never depends on (or
# disturbs) any other Node.js on the computer.
say "Getting Node.js"
curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || fail "Couldn't reach nodejs.org. Check the internet connection and try again."
NODE_FILE="$(grep -oE "node-v[0-9.]+-$OS-$ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -n1)"
[ -n "$NODE_FILE" ] || fail "Couldn't find Node.js for $OS-$ARCH."
NODE_VERSION="${NODE_FILE%-$OS-$ARCH.tar.gz}"
if [ "$("$NODE_DIR/bin/node" -v 2>/dev/null || true)" = "${NODE_VERSION#node-}" ]; then
	echo "Node.js ${NODE_VERSION#node-} is already installed."
else
	curl -fL --progress-bar "$NODE_DIST/$NODE_FILE" -o "$TMP/$NODE_FILE"
	[ "$(sha256 "$TMP/$NODE_FILE")" = "$(grep " $NODE_FILE\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)" ] ||
		fail "The Node.js download was damaged. Please run the installer again."
	rm -rf "$NODE_DIR"
	mkdir -p "$NODE_DIR"
	tar -xzf "$TMP/$NODE_FILE" -C "$NODE_DIR" --strip-components=1
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "Using Node.js $(node -v)"

# ── 3. The app ────────────────────────────────────────────────────────────────
say "Downloading Pi Learn"
curl -fsSL "$TARBALL_URL" -o "$TMP/app.tar.gz" ||
	fail "Couldn't download Pi Learn from GitHub. If the repository is private, it has to be made public first."
mkdir -p "$TMP/app"
tar -xzf "$TMP/app.tar.gz" -C "$TMP/app" --strip-components=1
[ -f "$TMP/app/package.json" ] || fail "The download doesn't look like Pi Learn."

# Stop a running copy so it restarts with the new version.
pkill -f "tsx/dist/cli.mjs server/index.ts" 2>/dev/null || true
pkill -f "tsx server/index.ts" 2>/dev/null || true

# Reuse already-installed packages to make updates quick.
if [ -d "$APP_DIR/node_modules" ]; then mv "$APP_DIR/node_modules" "$TMP/app/"; fi
rm -rf "$APP_DIR"
mv "$TMP/app" "$APP_DIR"

say "Installing Pi Learn's components (this takes a few minutes the first time)"
cd "$APP_DIR"
npm install --no-audit --no-fund --loglevel=error --update-notifier=false </dev/null
say "Building the app"
npm run build --silent >/dev/null

# ── 4. Launcher ───────────────────────────────────────────────────────────────
# Programs started from an icon don't load Terminal's settings, and nobody sees
# their errors. So the launcher uses absolute paths only and logs to a file.
# setsid keeps the app running after the launcher exits (macOS has no setsid,
# and doesn't need it).
DETACH="nohup"
command -v setsid >/dev/null && DETACH="setsid nohup"
if [ "$OS" = darwin ]; then OPEN_CMD='open "$URL"'; else
	OPEN_CMD='for h in garcon-url-handler /opt/google/cros-containers/bin/garcon-url-handler xdg-open; do
	if command -v "$h" >/dev/null; then "$h" "$URL"; exit 0; fi
done'
fi
cat >"$APP_DIR/launch.sh" <<EOF
#!/bin/bash
# Starts Pi Learn in the background if it isn't running, then opens it in the browser.
export PATH="$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin"
cd "$APP_DIR"
URL=http://127.0.0.1:4747
LOG="$DATA_DIR/app.log"
if ! curl -s -o /dev/null "\$URL"; then
	echo "--- starting \$(date)" >>"\$LOG"
	PI_LEARN_NO_OPEN=1 $DETACH node node_modules/tsx/dist/cli.mjs server/index.ts >>"\$LOG" 2>&1 </dev/null &
	for i in \$(seq 1 60); do curl -s -o /dev/null "\$URL" && break; sleep 1; done
fi
$OPEN_CMD
EOF
chmod +x "$APP_DIR/launch.sh"

# ── 5. Icon ───────────────────────────────────────────────────────────────────
if [ "$OS" = darwin ]; then
	# A tiny app in ~/Applications that runs the launcher.
	APP="$HOME/Applications/Pi Learn.app"
	rm -rf "$APP"
	mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
	cp "$APP_DIR/scripts/icon/pi-learn.icns" "$APP/Contents/Resources/PiLearn.icns"
	printf '#!/bin/bash\nexec "%s"\n' "$APP_DIR/launch.sh" >"$APP/Contents/MacOS/PiLearn"
	chmod +x "$APP/Contents/MacOS/PiLearn"
	cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Pi Learn</string>
	<key>CFBundleDisplayName</key><string>Pi Learn</string>
	<key>CFBundleIdentifier</key><string>io.github.mryeburn.pilearn</string>
	<key>CFBundleExecutable</key><string>PiLearn</string>
	<key>CFBundleIconFile</key><string>PiLearn</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
EOF
	touch "$APP"
	# Put it in the Dock, once.
	if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "Pi%20Learn.app"; then
		defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://${APP// /%20}/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>" &&
			killall Dock 2>/dev/null || true
	fi
	DONE_MSG='Click the Pi Learn icon in your Dock to start it. (It is also in
  Launchpad, and in the Applications folder inside your home folder.)'
else
	# A launcher entry; on a Chromebook it shows up under "Linux apps".
	cp "$APP_DIR/scripts/icon/pi-learn.png" "$DATA_DIR/icon.png"
	mkdir -p "$HOME/.local/share/applications"
	cat >"$HOME/.local/share/applications/pi-learn.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pi Learn
Comment=Learn anything with your AI tutor
Exec=$APP_DIR/launch.sh
Icon=$DATA_DIR/icon.png
EOF
	DONE_MSG='Open the launcher, go into the "Linux apps" folder and click "Pi Learn".
  (Right-click it and choose "Pin to shelf" to keep it handy.)'
fi

say "Done!"
cat <<EOF

  Pi Learn is installed. You can close this window.

  $DONE_MSG

  The first time, Pi Learn asks you to connect an AI provider.

EOF
}
