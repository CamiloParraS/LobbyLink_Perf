# Corre las colecciones de AMD uProf sobre la app en Windows nativo.
# Ejecutar en PowerShell COMO ADMINISTRADOR, con mongod corriendo y sin otros programas abiertos:
#   cd lobbylink_perfv3
#   powershell -ExecutionPolicy Bypass -File setup\uprof.ps1            # los 4 casos (~20 min)
#   powershell -ExecutionPolicy Bypass -File setup\uprof.ps1 -Quick     # solo login-1w (~5 min, para probar que uProf funciona)
# Deja todo en resultados\_uprof_<fecha>\ (reportes, logs de cada corrida, versión de uProf, estado de Hyper-V).
param(
  [switch]$Quick,
  [switch]$Tbp,           # forzar TBP; se activa solo si hay hipervisor
  [string]$Cli = "C:\Program Files\AMD\AMDuProf\bin\AMDuProfCLI.exe",
  [int]$Warm = 30,        # calentamiento de run.mjs (s)
  [int]$Collect = 60,     # duración de cada colección (s)
  [int]$Port = 8080
)
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Abre PowerShell como administrador." }
if (-not (Test-Path $Cli)) { throw "No encuentro AMDuProfCLI en $Cli (pasa -Cli <ruta>)." }

$root = Split-Path -Parent $PSScriptRoot            # lobbylink_perfv3
Set-Location $root
$jar = Join-Path $root "jars\disenofinal-base.jar"
if (-not (Test-Path $jar)) { throw "Falta $jar" }

$fecha = Get-Date -Format "yyyyMMdd_HHmm"
$out = Join-Path $root "resultados\_uprof_$fecha"
New-Item -ItemType Directory -Path $out | Out-Null

# Metadatos: versión de uProf y Hyper-V
(& $Cli --version 2>&1 | Out-String) | Set-Content "$out\uprof_version.txt"
(bcdedit /enum '{current}' 2>&1 | Select-String hypervisorlaunchtype | Out-String) | Set-Content "$out\hyperv.txt"
(Get-CimInstance Win32_ComputerSystem).HypervisorPresent | Set-Content "$out\hypervisor_present.txt"
"HypervisorPresent: $(Get-Content "$out\hypervisor_present.txt")  (True = Windows sobre hipervisor, uProf puede fallar)"
if ((Get-CimInstance Win32_ComputerSystem).HypervisorPresent) {
  $Tbp = $true
  "AVISO: hipervisor activo (WSL2/VBS). uProf solo permite TBP: se usara --config tbp (hotspots por funcion, SIN IPC ni fallos de cache)."
  "       Evidencia en $out\hyperv.txt y hypervisor_present.txt"
}
if ($Tbp) { "MODO TBP" | Set-Content "$out\modo.txt" } else { "MODO PMC (cpi/data_access)" | Set-Content "$out\modo.txt" }

if (-not (Get-NetTCPConnection -LocalPort 27017 -State Listen -ErrorAction SilentlyContinue)) { throw "mongod no escucha en 27017." }

# caso: nombre, perfil, workers, preset
$casos = @(
  @{ n = 'login-1w-ipc';  p = 'login';     w = 1; c = 'cpi' },
  @{ n = 'login-2w-ipc';  p = 'login';     w = 2; c = 'cpi' },
  @{ n = 'list-1w-ipc';   p = 'solo-list'; w = 1; c = 'cpi' },
  @{ n = 'list-1w-data';  p = 'solo-list'; w = 1; c = 'data_access' }
)
if ($Tbp) {
  # TBP no distingue presets de contadores: un caso por carga
  $casos = @(
    @{ n = 'login-1w-tbp'; p = 'login';     w = 1; c = 'tbp' },
    @{ n = 'login-2w-tbp'; p = 'login';     w = 2; c = 'tbp' },
    @{ n = 'list-1w-tbp';  p = 'solo-list'; w = 1; c = 'tbp' }
  )
}
if ($Quick) { $casos = @($casos[0]) }

$secs = $Warm + $Collect + 40                        # carga dura lo suficiente para cubrir la colección

foreach ($k in $casos) {
  "`n=== $($k.n) ==="
  $log = "$out\$($k.n)_run.log"
  $node = Start-Process node -WorkingDirectory $root -PassThru -NoNewWindow `
    -RedirectStandardOutput $log -RedirectStandardError "$out\$($k.n)_run.err" `
    -ArgumentList @('telemetry/run.mjs','--env','windows','--label',"uprof-$($k.n)",'--profile',$k.p,'--workers',"$($k.w)",'--seconds',"$secs",'--warm',"$Warm",'--jar',"`"$jar`"")

  # esperar a que la carga arranque
  $t0 = Get-Date
  while (-not ((Test-Path $log) -and (Select-String -Path $log -Pattern 'carga: perfil' -Quiet))) {
    if ($node.HasExited) { throw "run.mjs terminó antes de la carga; mira $log y el .err" }
    if (((Get-Date) - $t0).TotalSeconds -gt 180) { throw "Timeout esperando la carga." }
    Start-Sleep 2
  }
  Start-Sleep -Seconds ($Warm + 5)                   # terminar calentamiento

  $app = (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess | Select-Object -First 1
  "PID app: $app; colectando $Collect s ($($k.c))"
  try {
    # uProf escribe WARNINGs en stderr; con 'Stop' PowerShell los convierte en error. Se tolera y se juzga por el codigo de salida.
    $ErrorActionPreference = 'Continue'
    & $Cli collect --config $k.c --pid $app -d $Collect -o "$out\$($k.n)" 2>&1 | ForEach-Object { "$_" } | Tee-Object "$out\$($k.n)_collect.log"
    $rc = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($rc -ne 0) { throw "AMDuProfCLI collect devolvio codigo $rc; ver $out\$($k.n)_collect.log" }
  } catch {
    "ERROR en la colección: $_"
    # cerrar carga, app y arbol de procesos de run.mjs para no dejar nada corriendo
    taskkill /PID $node.Id /T /F 2>&1 | Out-Null
    if ($app) { Stop-Process -Id $app -Force -ErrorAction SilentlyContinue }
    throw
  }
  # la carpeta de la sesion es -o mismo (contiene cpu\, metadata\, session.uprof); no un subdirectorio
  $dir = Get-Item "$out\$($k.n)" -ErrorAction SilentlyContinue
  if ($dir -and (Test-Path "$($dir.FullName)\session.uprof")) {
    $ErrorActionPreference = 'Continue'
    & $Cli report -i $dir.FullName 2>&1 | ForEach-Object { "$_" } | Tee-Object "$out\$($k.n)_report.log" | Select-Object -Last 15
    $ErrorActionPreference = 'Stop'
  } else { "AVISO: no se generó carpeta de colección (¿Hyper-V?). Ver $out\$($k.n)_collect.log" }

  # dejar que run.mjs termine solo (guarda su carpeta en resultados\); si no, esperar
  $node.WaitForExit(($secs + 120) * 1000) | Out-Null
  if (-not $node.HasExited) { Stop-Process -Id $node.Id -Force }
  Start-Sleep 10
}
"`nListo. Resultados en $out"
if ($Tbp) { "Modo TBP: anota las funciones/modulos con mas muestras (JVM, mongod no, solo la app). No hay IPC ni fallos de cache." }
else { "Anota IPC, fallos L1/L2/L3 por 1000 instrucciones (ver setup\UPROF.md sección 4)." }
