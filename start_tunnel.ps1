param(
    [string]$Cloudflared = $env:SNAP_POCKET_CLOUDFLARED,
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30,
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-CloudflaredPath {
    param([string]$RequestedPath)

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        $candidates = @([Environment]::ExpandEnvironmentVariables($RequestedPath.Trim('"')))
    } else {
        $candidates = @(
            (Join-Path $PSScriptRoot "cloudflared\cloudflared.exe")
            (Join-Path $PSScriptRoot "cloudflared.exe")
            (Join-Path (Split-Path $PSScriptRoot -Parent) "cloudflared\cloudflared.exe")
            "cloudflared.exe"
        )
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
        $command = Get-Command -Name $candidate -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $command) {
            return $command.Source
        }
    }

    throw "cloudflared.exe was not found. Place it in '$PSScriptRoot\cloudflared\cloudflared.exe', add it to PATH, or set SNAP_POCKET_CLOUDFLARED to its full path."
}

function Test-PageResponse {
    param(
        [string]$Url,
        [int]$TimeoutMilliseconds = 2000
    )

    $cancellation = New-Object System.Threading.CancellationTokenSource
    $response = $null
    try {
        $cancellation.CancelAfter($TimeoutMilliseconds)
        $requestTask = $httpClient.GetAsync(
            $Url,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
            $cancellation.Token
        )
        if (-not $requestTask.Wait($TimeoutMilliseconds)) {
            $cancellation.Cancel()
            return $false
        }
        $response = $requestTask.GetAwaiter().GetResult()
        return [int]$response.StatusCode -eq 200
    } catch {
        return $false
    } finally {
        if ($null -ne $response) {
            $response.Dispose()
        }
        $cancellation.Dispose()
    }
}

function Get-LanBaseUrl {
    # Match app.py's get_lan_ip(): select the IPv4 route to 8.8.8.8 without sending data.
    $socket = New-Object System.Net.Sockets.UdpClient ([System.Net.Sockets.AddressFamily]::InterNetwork)
    try {
        $socket.Connect("8.8.8.8", 80)
        $address = $socket.Client.LocalEndPoint.Address
        if ([System.Net.IPAddress]::IsLoopback($address) -or
            $address.Equals([System.Net.IPAddress]::Any) -or
            $address.Equals([System.Net.IPAddress]::Broadcast)) {
            throw "No usable LAN IPv4 address was detected."
        }
        return "http://{0}:5000" -f $address.IPAddressToString
    } catch {
        throw "LAN IPv4 detection failed: $($_.Exception.Message)"
    } finally {
        $socket.Dispose()
    }
}

function Save-AccessUrl {
    param([string]$Url, [string]$Path)

    $temporaryPath = "$Path.$PID.tmp"
    try {
        # app.py reads UTF-16. Publish the complete file in a single rename.
        [System.IO.File]::WriteAllText($temporaryPath, $Url, [System.Text.Encoding]::Unicode)
        if ([System.IO.File]::Exists($Path)) {
            [System.IO.File]::Replace($temporaryPath, $Path, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [System.IO.File]::Move($temporaryPath, $Path)
        }
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

try {
    $cloudflaredPath = Resolve-CloudflaredPath -RequestedPath $Cloudflared
    Write-Host "Cloudflare executable: $cloudflaredPath"
    if ($CheckOnly) {
        & $cloudflaredPath --version
        if ($LASTEXITCODE -ne 0) {
            throw "cloudflared version check failed with code $LASTEXITCODE."
        }
        exit 0
    }
} catch {
    Write-Host ("Cloudflare setup failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}

$tunnelOrigin = "http://localhost:5000"
$tunnelUrlPath = Join-Path $PSScriptRoot "tunnel_url.txt"
$logPath = Join-Path ([System.IO.Path]::GetTempPath()) ("snap-pocket-cloudflared-{0}.log" -f $PID)
$tunnelProcess = $null
$httpClient = $null
$lanFallbackSaved = $false
$scriptExitCode = 0

try {
    # Prevent the app from reusing an expired quick-tunnel address.
    if (Test-Path -LiteralPath $tunnelUrlPath) {
        Remove-Item -LiteralPath $tunnelUrlPath -Force
    }
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue

    Add-Type -AssemblyName System.Net.Http
    $httpHandler = New-Object System.Net.Http.HttpClientHandler
    $httpHandler.AllowAutoRedirect = $false
    $httpClient = New-Object System.Net.Http.HttpClient ($httpHandler)

    $arguments = @(
        "tunnel"
        "--url", $tunnelOrigin
        "--loglevel", "info"
        "--logfile", ('"{0}"' -f $logPath)
    )

    $tunnelProcess = Start-Process `
        -FilePath $cloudflaredPath `
        -ArgumentList $arguments `
        -WindowStyle Hidden `
        -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $tunnelUrl = $null
    $tunnelReady = $false
    $startupFailure = $null

    while ([DateTime]::UtcNow -lt $deadline) {
        $tunnelProcess.Refresh()
        if ($tunnelProcess.HasExited) {
            $logText = if (Test-Path -LiteralPath $logPath) {
                Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
            } else {
                ""
            }
            $startupFailure = "cloudflared exited before the tunnel was ready. $logText"
            break
        }

        if (-not $tunnelUrl -and (Test-Path -LiteralPath $logPath)) {
            $logText = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
            if ($logText) {
                $match = [regex]::Match($logText, "https://[a-z0-9-]+\.trycloudflare\.com", "IgnoreCase")
                if ($match.Success) {
                    $tunnelUrl = $match.Value
                }
            }
        }

        $remainingMilliseconds = [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if ($tunnelUrl -and $remainingMilliseconds -gt 0) {
            $requestTimeout = [int][Math]::Min(2000, $remainingMilliseconds)
            if (Test-PageResponse -Url "$tunnelUrl/main_page" -TimeoutMilliseconds $requestTimeout) {
                $tunnelProcess.Refresh()
                $tunnelReady = -not $tunnelProcess.HasExited
                break
            }
        }

        $remainingMilliseconds = [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if ($remainingMilliseconds -gt 0) {
            Start-Sleep -Milliseconds ([int][Math]::Min(250, $remainingMilliseconds))
        }
    }

    if (-not $tunnelReady) {
        if (-not $startupFailure) {
            $startupFailure = "Timed out after $TimeoutSeconds seconds while waiting for a Cloudflare quick-tunnel URL and HTTP 200 from /main_page."
        }
        Write-Host ("Cloudflare startup connection failed: {0}" -f $startupFailure) -ForegroundColor Yellow

        if (-not $tunnelProcess.HasExited) {
            Stop-Process -InputObject $tunnelProcess -Force
            if (-not $tunnelProcess.WaitForExit(5000)) {
                throw "Could not stop the failed Cloudflare tunnel process."
            }
        }

        # Flask binds to IPv4; keep this bounded check independent of localhost resolution.
        if (-not (Test-PageResponse -Url "http://127.0.0.1:5000/main_page")) {
            throw "Local Flask /main_page did not return HTTP 200. LAN fallback was not saved."
        }
        $lanBaseUrl = Get-LanBaseUrl
        Save-AccessUrl -Url $lanBaseUrl -Path $tunnelUrlPath
        $lanFallbackSaved = $true
        Write-Host "`nAccess mode: LAN fallback (Celery and Flask remain running)."
        Write-Host "Base URL saved to tunnel_url.txt: $lanBaseUrl"
        Write-Host "Camera page: $lanBaseUrl/main_page"
        Write-Host "Restart run.bat to try Cloudflare again.`n"
    } else {
        Save-AccessUrl -Url $tunnelUrl -Path $tunnelUrlPath
        Write-Host "`nAccess mode: Cloudflare Tunnel"
        Write-Host "Cloudflare Tunnel URL saved: $tunnelUrl"
        Write-Host "Camera page: $tunnelUrl/main_page"
        Write-Host "Press Ctrl+C to stop the tunnel.`n"

        Wait-Process -Id $tunnelProcess.Id
        $tunnelProcess.Refresh()
        if ($tunnelProcess.ExitCode -ne 0) {
            throw "cloudflared exited with code $($tunnelProcess.ExitCode)."
        }
    }
} catch {
    Write-Host ("Tunnel startup or operation failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    $scriptExitCode = 1
} finally {
    if ($null -ne $tunnelProcess -and -not $tunnelProcess.HasExited) {
        Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    }

    # Expired public addresses are removed; a successful LAN fallback remains usable.
    if (-not $lanFallbackSaved) {
        Remove-Item -LiteralPath $tunnelUrlPath -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    if ($null -ne $httpClient) {
        $httpClient.Dispose()
    }
}

exit $scriptExitCode
