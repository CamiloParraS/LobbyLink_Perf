# Muestreador para Windows. Lo lanza agent.mjs; emite una linea JSON por muestra.
# Equivalentes de Linux: us=PercentUserTime, sy=PercentPrivilegedTime, disco=PerfDisk PhysicalDisk _Total,
# RSS = WorkingSetPrivate (memoria privada residente). La CPU de cada proceso va como % de UN nucleo (100 = un nucleo completo).
# Frecuencia: Processor Information da por hilo logico "% Processor Performance" (100 = frecuencia base; >100 = turbo) y
# "Processor Frequency" (la base en MHz). MHz efectivos = base * rendimiento / 100. Se leen con CIM porque typeperf no acepta
# los nombres en ingles en un Windows en espanol. cpu.perf y cpu.mhz van en el mismo orden que cpu.cores (hilo 0, 1, ...).
# Los contadores PerfProc no requieren administrador. El trafico loopback (app<->mongo<->generador) NO aparece en los contadores de NIC.
param([int]$AppPort = 8080, [double]$Every = 2, [string]$Mongo = "mongod", [string]$GenPidFile = "", [int]$Samples = 1000000)
$ErrorActionPreference = "SilentlyContinue"
for ($i = 0; $i -lt $Samples; $i++) {
  $t0 = Get-Date
  $appPid = (Get-NetTCPConnection -LocalPort $AppPort -State Listen | Select-Object -First 1).OwningProcess
  $genPid = 0; if ($GenPidFile -and (Test-Path $GenPidFile)) { $genPid = [int](Get-Content $GenPidFile -First 1) }
  $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor
  $tot = $cpu | ? Name -eq "_Total"
  $cores = @($cpu | ? Name -ne "_Total" | Sort-Object { [int]($_.Name -replace '\D','') } | % { [int]$_.PercentProcessorTime })
  $pi = @(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation | ? { $_.Name -notlike '*_Total' } | Sort-Object { [int](($_.Name -split ',')[1]) })
  $perf = @($pi | % { [int]$_.PercentProcessorPerformance }); $mhzBase = [int]($pi | Select-Object -First 1).ProcessorFrequency
  $mhz = @($pi | % { [int]([double]$_.ProcessorFrequency * [double]$_.PercentProcessorPerformance / 100) })
  $d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
  $n = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface
  $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process
  $app = $p | ? IDProcess -eq $appPid
  $mon = $p | ? { $_.Name -like "$Mongo*" }
  $gen = $p | ? IDProcess -eq $genPid
  function Proc($x) { if (-not $x) { return $null }
    @{ cpu = [math]::Round((($x | Measure-Object PercentProcessorTime -Sum).Sum), 1)
       rssMB = [math]::Round((($x | Measure-Object WorkingSetPrivate -Sum).Sum) / 1MB, 1)
       threads = [int](($x | Measure-Object ThreadCount -Sum).Sum)
       ioReadMBs = [math]::Round((($x | Measure-Object IOReadBytesPersec -Sum).Sum) / 1MB, 3)
       ioWriteMBs = [math]::Round((($x | Measure-Object IOWriteBytesPersec -Sum).Sum) / 1MB, 3) } }
  $o = @{
    at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    cpu = @{ busy = [double](100 - $tot.PercentIdleTime); user = [double]$tot.PercentUserTime; system = [double]$tot.PercentPrivilegedTime; idle = [double]$tot.PercentIdleTime; cores = $cores; perf = $perf; mhz = $mhz; mhzBase = $mhzBase }
    disk = @{ iops = [double]$d.DiskTransfersPersec; readIops = [double]$d.DiskReadsPersec; writeIops = [double]$d.DiskWritesPersec; mbs = [math]::Round($d.DiskBytesPersec / 1MB, 3); util = [double]$d.PercentDiskTime; queue = [double]$d.AvgDiskQueueLength }
    net = @{ rxMBs = [math]::Round((($n | Measure-Object BytesReceivedPersec -Sum).Sum) / 1MB, 4); txMBs = [math]::Round((($n | Measure-Object BytesSentPersec -Sum).Sum) / 1MB, 4) }
    app = (Proc $app); mongo = (Proc $mon); gen = (Proc $gen)
  }
  $o | ConvertTo-Json -Compress -Depth 6
  $left = $Every - ((Get-Date) - $t0).TotalSeconds
  if ($left -gt 0) { Start-Sleep -Milliseconds ([int]($left * 1000)) }
}
