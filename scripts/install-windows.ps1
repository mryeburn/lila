# One-step installer for LILA on Windows.
#
# Installs everything LILA needs: its own copy of Node.js, the app itself,
# and a "LILA" icon on the desktop and in the Start menu. Nothing else on
# the computer is changed, and no administrator rights are needed. Safe to run
# again: it updates the app to the latest version and keeps your lessons and
# sign-ins.
#
#   irm https://raw.githubusercontent.com/mryeburn/lila/main/scripts/install-windows.ps1 | iex

& {
	$ErrorActionPreference = 'Stop'
	# Invoke-WebRequest is very slow while it draws a progress bar.
	$ProgressPreference = 'SilentlyContinue'
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$Repo = 'mryeburn/lila'
	$NodeDist = 'https://nodejs.org/dist/latest-v22.x'
	$AppDir = Join-Path $HOME 'lila'
	$DataDir = Join-Path $HOME '.lila'
	$NodeDir = Join-Path $DataDir 'node'

	function Say($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
	function Fail($msg) { throw [System.Exception]::new($msg) }
	function Download($url, $file, $problem) {
		try { Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing } catch { Fail $problem }
	}
	function Extract($zip, $dest) {
		New-Item -ItemType Directory -Force -Path $dest | Out-Null
		# The tar.exe built into Windows 10 and 11 is much faster than Expand-Archive.
		$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
		if (Test-Path $tar) {
			& $tar -xf $zip -C $dest
			if ($LASTEXITCODE -ne 0) { Fail "Couldn't unpack $zip." }
		} else {
			Expand-Archive -Path $zip -DestinationPath $dest -Force
		}
		# Both zips hold a single folder; return it.
		Get-ChildItem -Path $dest -Directory | Select-Object -First 1
	}

	try {
		$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
		New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
		$tmp = Join-Path ([IO.Path]::GetTempPath()) ("lila-" + [guid]::NewGuid())
		New-Item -ItemType Directory -Path $tmp | Out-Null

		# Stop a running copy, so its files can be replaced.
		Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
			Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($NodeDir, 'OrdinalIgnoreCase') } |
			ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

		# ── 1. Node.js ──────────────────────────────────────────────────────────
		# LILA gets its own private copy of Node.js, so it never depends on
		# (or disturbs) any other Node.js on the computer.
		Say 'Getting Node.js'
		$sums = Join-Path $tmp 'SHASUMS256.txt'
		Download "$NodeDist/SHASUMS256.txt" $sums "Couldn't reach nodejs.org. Check the internet connection and try again."
		$line = Get-Content $sums | Where-Object { $_ -match "  node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
		if (-not $line) { Fail "Couldn't find Node.js for win-$arch." }
		$nodeZip = ($line -split '\s+')[1]
		$nodeVersion = ($nodeZip -split '-')[1]
		$nodeExe = Join-Path $NodeDir 'node.exe'
		$current = if (Test-Path $nodeExe) { & $nodeExe -v } else { '' }
		if ($current -eq $nodeVersion) {
			Write-Host "Node.js $nodeVersion is already installed."
		} else {
			Download "$NodeDist/$nodeZip" (Join-Path $tmp $nodeZip) "Couldn't download Node.js. Check the internet connection and try again."
			$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $nodeZip)).Hash.ToLower()
			if ($hash -ne ($line -split '\s+')[0]) { Fail 'The Node.js download was damaged. Please run the installer again.' }
			$unpacked = Extract (Join-Path $tmp $nodeZip) (Join-Path $tmp 'node')
			if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
			Move-Item $unpacked.FullName $NodeDir
		}
		$env:Path = "$NodeDir;$env:Path"
		Write-Host "Using Node.js $(& $nodeExe -v)"

		# ── 2. The app ──────────────────────────────────────────────────────────
		Say 'Downloading LILA'
		# Pin the exact version, so the app knows what it's running when checking for updates.
		$sha = ''
		try {
			$refs = (Invoke-WebRequest -Uri "https://github.com/$Repo.git/info/refs?service=git-upload-pack" -UseBasicParsing).Content
			if ($refs -is [byte[]]) { $refs = [Text.Encoding]::ASCII.GetString($refs) }
			if ($refs -match '([0-9a-f]{40}) refs/heads/main') { $sha = $Matches[1] }
		} catch { }
		if ($sha -notmatch '^[0-9a-f]{40}$') { $sha = '' }
		$ref = if ($sha) { $sha } else { 'refs/heads/main' }
		$ZipUrl = if ($env:LILA_ZIP) { $env:LILA_ZIP } else { "https://github.com/$Repo/archive/$ref.zip" }
		Download $ZipUrl (Join-Path $tmp 'app.zip') "Couldn't download LILA from GitHub. If the repository is private, it has to be made public first."
		$app = Extract (Join-Path $tmp 'app.zip') (Join-Path $tmp 'app')
		if (-not (Test-Path (Join-Path $app.FullName 'package.json'))) { Fail "The download doesn't look like LILA." }
		# Reuse already-installed packages to make updates quick.
		$oldModules = Join-Path $AppDir 'node_modules'
		if (Test-Path $oldModules) { Move-Item $oldModules $app.FullName }
		if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
		Move-Item $app.FullName $AppDir
		if ($sha) { Set-Content -Path (Join-Path $AppDir '.version') -Value "{`"repo`":`"$Repo`",`"sha`":`"$sha`"}" -Encoding ASCII }

		Say "Installing LILA's components (this takes a few minutes the first time)"
		Push-Location $AppDir
		try {
			$npm = Join-Path $NodeDir 'npm.cmd'
			& $npm install --no-audit --no-fund --loglevel=error --update-notifier=false
			if ($LASTEXITCODE -ne 0) { Fail 'Installing the components failed. See the messages above.' }
			Say 'Building the app'
			& $npm run build --silent | Out-Null
			if ($LASTEXITCODE -ne 0) { Fail 'Building the app failed. See the messages above.' }
		} finally { Pop-Location }

		# ── 3. Launcher ─────────────────────────────────────────────────────────
		# Starts LILA hidden in the background if it isn't running, then
		# opens it in the browser. Errors go to a log file, since nobody sees them.
		$q = { param($s) "'" + ($s -replace "'", "''") + "'" }
		$launcher = @'
# Starts LILA in the background if it isn't running, then opens it in the browser.
$url = 'http://127.0.0.1:4848'
function Up { try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; $true } catch { $false } }
if (-not (Up)) {
	$env:LILA_NO_OPEN = '1'
	$env:Path = __NODE_DIR__ + ';' + $env:Path
	Start-Process -FilePath (Join-Path __NODE_DIR__ 'node.exe') -ArgumentList 'node_modules/tsx/dist/cli.mjs', 'server/index.ts' `
		-WorkingDirectory __APP_DIR__ -WindowStyle Hidden `
		-RedirectStandardOutput (Join-Path __DATA_DIR__ 'app.log') -RedirectStandardError (Join-Path __DATA_DIR__ 'app-errors.log')
	for ($i = 0; $i -lt 60 -and -not (Up); $i++) { Start-Sleep -Seconds 1 }
}
if (-not $env:LILA_NO_BROWSER) { Start-Process $url }
'@
		$launcher = $launcher.Replace('__NODE_DIR__', (& $q $NodeDir)).Replace('__APP_DIR__', (& $q $AppDir)).Replace('__DATA_DIR__', (& $q $DataDir))
		Set-Content -Path (Join-Path $AppDir 'launch.ps1') -Value $launcher -Encoding UTF8

		# ── 4. Icons ────────────────────────────────────────────────────────────
		$icon = Join-Path $DataDir 'icon.ico'
		Copy-Item (Join-Path $AppDir 'scripts\icon\lila.ico') $icon -Force
		$shell = New-Object -ComObject WScript.Shell
		foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
			$link = $shell.CreateShortcut((Join-Path $folder 'LILA.lnk'))
			$link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
			$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $AppDir 'launch.ps1')`""
			$link.WorkingDirectory = $AppDir
			$link.IconLocation = $icon
			$link.WindowStyle = 7
			$link.Description = 'Learn anything with your AI tutor'
			$link.Save()
		}

		# Updating from inside the app: start the new version; the open page reloads itself.
		if ($env:LILA_RESTART) {
			$env:LILA_NO_BROWSER = '1'
			& (Join-Path $AppDir 'launch.ps1')
		}

		Say 'Done!'
		Write-Host ''
		Write-Host '  LILA is installed. You can close this window.'
		Write-Host ''
		Write-Host '  Double-click the LILA icon on your desktop to start it.'
		Write-Host '  (It is also in the Start menu.)'
		Write-Host ''
		Write-Host '  The first time, LILA asks you to connect an AI provider.'
		Write-Host ''
	} catch {
		Write-Host "`nSetup stopped: $($_.Exception.Message)" -ForegroundColor Red
	} finally {
		if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
	}
}
