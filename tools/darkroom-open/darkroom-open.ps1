# DARKROOM OS: opener for the darkroom-open:// custom protocol.
#
# Invoked by Windows whenever someone clicks a "darkroom-open:..." link
# (registered via install-darkroom-open.reg). Windows passes the full
# clicked URI as the first argument, e.g.:
#   darkroom-open:%5C%5CDATACENTER%5CProjekti%5CP0288%20-%2055%20Deans
# This strips the scheme, URL-decodes it back into a real Windows path, and
# opens it in Explorer. Any failure (missing/unreachable path, anything
# unexpected) shows a plain message box instead of failing silently, since
# there is no console window for anyone to see an error in otherwise.

param(
    [Parameter(Position = 0)]
    [string]$RawUri
)

function Show-Message([string]$Text, [string]$Icon = 'Warning') {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    [System.Windows.Forms.MessageBox]::Show(
        $Text, 'Darkroom Open',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::$Icon
    ) | Out-Null
}

try {
    if ([string]::IsNullOrWhiteSpace($RawUri)) {
        Show-Message 'Nije prosledjena nijedna putanja.'
        exit
    }

    $prefix = 'darkroom-open:'
    $uri = $RawUri
    if ($uri.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $uri = $uri.Substring($prefix.Length)
    }
    $uri = $uri.TrimStart('/')

    $decoded = [System.Uri]::UnescapeDataString($uri)
    $path = $decoded.Replace('/', '\')

    # Defense in depth: this helper only ever exists to open the studio's
    # own datacenter share. It never runs or executes anything from the
    # target path (Start-Process explorer.exe below just navigates a
    # Explorer window, same as double-clicking the address bar), so there
    # is no privilege-escalation angle here regardless — but scoping it to
    # one known prefix means the link genuinely cannot be repurposed to
    # point Explorer at some other local/network path.
    if ($path -notlike '\\DATACENTER\*') {
        Show-Message "Ovaj link ne vodi na DATACENTER share pa je odbijen:`n`n$path"
        exit
    }

    if (-not (Test-Path -LiteralPath $path)) {
        Show-Message "Putanja ne postoji ili nije dostupna sa ovog racunara (proveri da li si na studio mrezi):`n`n$path"
        exit
    }

    Start-Process explorer.exe -ArgumentList "`"$path`""
} catch {
    Show-Message "Nesto je poslo po zlu pri otvaranju foldera:`n`n$($_.Exception.Message)" 'Error'
}
