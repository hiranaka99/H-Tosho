$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' }
if ($procs) {
  foreach ($p in $procs) {
    Write-Output ("Killing {0}" -f $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Output "No dist/index.js processes running"
}
Start-Sleep -Milliseconds 1200
$left = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' }
if ($left) { Write-Output ("STILL RUNNING: " + (($left | ForEach-Object ProcessId) -join ',')) } else { Write-Output "Clean" }
