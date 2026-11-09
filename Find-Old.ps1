# Sucht installierte Whiteboard-Version 1.0.53 und gibt die Ordner aus.
$self = Split-Path -Parent $MyInvocation.MyCommand.Path
$roots = @((Split-Path $self -Parent), (Split-Path (Split-Path $self -Parent) -Parent), (Get-Location).Path,
  [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'), (Join-Path $env:USERPROFILE 'Downloads'), $env:USERPROFILE,
  (Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root })) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$skip = 'node_modules','.git','Windows','Program Files','Program Files (x86)','ProgramData','AppData','$Recycle.Bin','System Volume Information'
$found = New-Object System.Collections.Generic.HashSet[string]
function Scan($dir, $depth) {
  if ($depth -lt 0) { return }
  try {
    $pj = Join-Path $dir 'package.json'
    if ((Test-Path (Join-Path $dir 'server.cjs')) -and (Test-Path $pj)) {
      $t = Get-Content $pj -Raw -ErrorAction SilentlyContinue
      if ($t -match 'realtime-whiteboard' -and $t -match '"1\.0\.53"') { [void]$found.Add((Resolve-Path $dir).Path); return }
    }
    Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | Where-Object { $skip -notcontains $_.Name -and $_.FullName -ne $self -and $_.Name -notlike '*_backup_*' } | ForEach-Object { Scan $_.FullName ($depth - 1) }
  } catch {}
}
foreach ($r in $roots) { Scan $r 4 }
$found | ForEach-Object { $_ }
