# SoundCloud and YouTube Music download helpers around scdl and yt-dlp.
#
#   Remove-Item Alias:sc -Force -ErrorAction SilentlyContinue   # Windows PowerShell maps sc to Set-Content
#   Import-Module <path>\MusicDownload.psm1
#
# Run both lines in your profile. A module cannot remove the global sc alias, and
# an alias wins over a function, so without the first line sc stays Set-Content.
#
# Environment, all optional:
#   SOUNDCLOUD_OAUTH_TOKEN   SoundCloud OAuth token for Go+ streams
#   SOUNDCLOUD_PROXY_URL     proxy for SoundCloud requests
#   YTDLP_COOKIES            Netscape cookie jar for YouTube Music (default: $HOME\yt-cookies.txt)
#   BGUTIL_POT_PROVIDER_DIR  bgutil-ytdlp-pot-provider checkout (default: $HOME\bgutil-ytdlp-pot-provider)

function Get-PotProviderDir {
  if ($env:BGUTIL_POT_PROVIDER_DIR) { return $env:BGUTIL_POT_PROVIDER_DIR }
  return (Join-Path $HOME 'bgutil-ytdlp-pot-provider')
}

function sc {
  param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Url,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$SCDLArgs
  )

  $extraArgs = @()
  $forwardArgs = @($SCDLArgs)

  if ($env:SOUNDCLOUD_OAUTH_TOKEN -and -not ($SCDLArgs -contains '--auth-token')) {
    $extraArgs += @('--auth-token', $env:SOUNDCLOUD_OAUTH_TOKEN)
  }

  if ($env:SOUNDCLOUD_PROXY_URL) {
    $ytDlpArgsIndex = [Array]::IndexOf($forwardArgs, '--yt-dlp-args')

    if ($ytDlpArgsIndex -ge 0 -and ($ytDlpArgsIndex + 1) -lt $forwardArgs.Count) {
      if ($forwardArgs[$ytDlpArgsIndex + 1] -notmatch '(^|\s)--proxy(\s|=|$)') {
        $forwardArgs[$ytDlpArgsIndex + 1] = "$($forwardArgs[$ytDlpArgsIndex + 1]) --proxy $env:SOUNDCLOUD_PROXY_URL"
      }
    } elseif ($ytDlpArgsIndex -lt 0) {
      $extraArgs += @('--yt-dlp-args', "--proxy $env:SOUNDCLOUD_PROXY_URL -f http_mp3_1_0/hls_mp3_1_0/bestaudio")
    }
  }

  scdl -l $Url @extraArgs @forwardArgs
}

function scf {
  param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Url
  )

  $args = @('-F')

  if ($env:SOUNDCLOUD_OAUTH_TOKEN) {
    $args += @('--username', 'oauth', '--password', $env:SOUNDCLOUD_OAUTH_TOKEN)
  }

  if ($env:SOUNDCLOUD_PROXY_URL) {
    $args += @('--proxy', $env:SOUNDCLOUD_PROXY_URL)
  }

  yt-dlp @args $Url
}

function scy {
  param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Url,

    [Parameter(Position = 1)]
    [string]$Path = '.'
  )

  $args = @(
    '--format', 'http_mp3_1_0/hls_mp3_1_0/bestaudio',
    '--embed-metadata',
    '--embed-thumbnail',
    '--convert-thumbnails', 'jpg',
    '--no-playlist',
    '--continue',
    '--retries', '10',
    '--fragment-retries', '10',
    '--output', (Join-Path $Path '%(uploader)s - %(title)s.%(ext)s')
  )

  if ($env:SOUNDCLOUD_OAUTH_TOKEN) {
    $args += @('--username', 'oauth', '--password', $env:SOUNDCLOUD_OAUTH_TOKEN)
  }

  if ($env:SOUNDCLOUD_PROXY_URL) {
    $args += @('--proxy', $env:SOUNDCLOUD_PROXY_URL)
  }

  yt-dlp @args $Url
}

function sci {
  param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Url
  )

  $clientIdPath = Join-Path $HOME '.cache\yt-dlp\soundcloud\client_id.json'
  if (-not (Test-Path $clientIdPath)) {
    yt-dlp --simulate $Url *> $null
  }

  $clientId = (Get-Content -Raw $clientIdPath | ConvertFrom-Json).data
  $resolveUrl = "https://api-v2.soundcloud.com/resolve?url=$([uri]::EscapeDataString($Url))&client_id=$clientId"
  $curlArgs = @('-sS', '--max-time', '30')

  if ($env:SOUNDCLOUD_PROXY_URL) {
    $curlArgs += @('-x', $env:SOUNDCLOUD_PROXY_URL)
  }

  if ($env:SOUNDCLOUD_OAUTH_TOKEN) {
    $curlArgs += @('-H', "Authorization: OAuth $env:SOUNDCLOUD_OAUTH_TOKEN")
  }

  $info = & curl.exe @curlArgs $resolveUrl | ConvertFrom-Json

  [pscustomobject]@{
    id = $info.id
    title = $info.title
    policy = $info.policy
    duration_sec = [math]::Round(($info.duration / 1000), 3)
    full_duration_sec = [math]::Round(($info.full_duration / 1000), 3)
    streamable = $info.streamable
    downloadable = $info.downloadable
    transcodings = ($info.media.transcodings | Measure-Object).Count
  } | Format-List

  $info.media.transcodings |
    Select-Object preset,
      @{Name = 'protocol'; Expression = { $_.format.protocol }},
      @{Name = 'mime'; Expression = { $_.format.mime_type }},
      @{Name = 'snipped'; Expression = { $_.snipped }} |
    Format-Table -AutoSize
}

function Start-YtPotProvider {
  $ping = $false
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:4416/ping' -TimeoutSec 2
    $ping = ($response.StatusCode -eq 200)
  } catch {
    $ping = $false
  }

  if ($ping) {
    return
  }

  $serverDir = Join-Path (Get-PotProviderDir) 'server'
  $mainJs = Join-Path $serverDir 'build\main.js'

  if (-not (Test-Path -LiteralPath $mainJs)) {
    throw "Missing bgutil provider at $mainJs"
  }

  $logDir = Join-Path (Get-PotProviderDir) 'logs'
  if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
  }

  Start-Process -FilePath 'node' `
    -ArgumentList @('build/main.js') `
    -WorkingDirectory $serverDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'provider.out.log') `
    -RedirectStandardError (Join-Path $logDir 'provider.err.log')

  Start-Sleep -Seconds 2
}

function Get-YtMusicCookieArgs {
  $cookiePath = $env:YTDLP_COOKIES
  if (-not $cookiePath) {
    $cookiePath = Join-Path $HOME 'yt-cookies.txt'
  }

  if (Test-Path -LiteralPath $cookiePath) {
    return @('--cookies', $cookiePath)
  }

  return @()
}

function ytmf {
  param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Url
  )

  Start-YtPotProvider

  $args = @(
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=web_music;youtubepot-bgutilhttp:base_url=http://localhost:4416'
  )

  $args += Get-YtMusicCookieArgs
  yt-dlp @args -F $Url
}

function ytm {
  param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Url,

    [Parameter(Position = 1)]
    [string]$Path = '.'
  )

  Start-YtPotProvider

  $args = @(
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=web_music;youtubepot-bgutilhttp:base_url=http://localhost:4416',
    '--format', '774/141/251/140/bestaudio',
    '--no-playlist',
    '--continue',
    '--embed-metadata',
    '--output', (Join-Path $Path '%(artist,uploader)s - %(title)s.%(ext)s')
  )

  $args += Get-YtMusicCookieArgs
  yt-dlp @args $Url
}

Export-ModuleMember -Function sc, scf, scy, sci, ytm, ytmf, Start-YtPotProvider
