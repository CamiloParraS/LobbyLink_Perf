# Contadores de hardware en el Ryzen con AMD uProf

Sirve para medir dos explicaciones que el informe da sin contadores: que el segundo hilo (SMT) ayuda a BCrypt porque llena huecos del núcleo, y que la CPU del listado se va en instrucciones y no en fallos de caché. uProf es gratuito y lee los contadores del Zen 4: instrucciones por ciclo (IPC) y fallos de L1, L2 y L3.

En la t3.small no se puede repetir: las instancias virtuales pequeñas no exponen estos contadores al sistema invitado. En el informe se dice así.

## 1. Instalar (una vez, unos 10 minutos)

1. Descarga AMD uProf para Windows desde la página oficial de AMD (buscar "AMD uProf download"). Pide aceptar la licencia. Anota la versión.
2. Instálalo con las opciones por defecto. Pide reiniciar porque instala un controlador.
3. Abre una terminal de **administrador** y comprueba que responde:

   ```powershell
   & "C:\Program Files\AMD\AMDuProf\bin\AMDuProfCLI.exe" --version
   & "C:\Program Files\AMD\AMDuProf\bin\AMDuProfCLI.exe" collect --help
   ```

   La ruta puede cambiar con la versión. Usa la que deje el instalador.

## 2. Hyper-V, el punto que puede fallar

Docker Desktop con WSL2 enciende Hyper-V, y con Hyper-V encendido Windows corre encima del hipervisor. En ese modo uProf puede no tener acceso a los contadores de núcleo y la colección falla o sale vacía. Primero prueba sin tocar nada (paso 3). Si falla:

```powershell
bcdedit /set hypervisorlaunchtype off     # como administrador, y reiniciar
```

Mientras esté apagado, Docker Desktop y WSL2 no funcionan. Para volver:

```powershell
bcdedit /set hypervisorlaunchtype auto    # y reiniciar
```

Haz esta medición en un momento en que no estén corriendo las campañas de Docker.

## 3. Medir (unos 20 minutos)

Con mongod corriendo y el PC sin otros programas, en una terminal de Git Bash como administrador:

```bash
cd lobbylink_perfv3
node telemetry/run.mjs --env windows --label uprof-login --profile login --workers 1,2 --seconds 120 --jar "$(cygpath -w jars/disenofinal-base.jar)" &
```

Cuando el log diga "carga: perfil login", en la terminal de PowerShell de administrador toma el PID de Java y colecta 60 s del preset de IPC:

```powershell
$app = (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess
& "C:\Program Files\AMD\AMDuProf\bin\AMDuProfCLI.exe" collect --config ipc --pid $app -d 60 -o C:\TETO\uprof\login
& "C:\Program Files\AMD\AMDuProf\bin\AMDuProfCLI.exe" report -i (Get-ChildItem C:\TETO\uprof\login -Directory | Select-Object -Last 1).FullName
```

Repite con `--label uprof-list --profile solo-list` para el listado del jar original, y con `--config data_access` para los fallos de caché de datos. Si un preset no existe en tu versión, `AMDuProfCLI info --list collect-configs` muestra los disponibles.

Con `--workers 1,2` la primera mitad de la corrida tiene un hilo trabajando y la segunda dos. Haz una colección en cada mitad: con 1 worker, empieza al terminar el calentamiento; con 2, empieza 20 s después de que el log cambie de nivel.

## 4. Qué anotar

- IPC con 1 y con 2 workers en login. Si el IPC por hilo baja poco con 2 hilos en el mismo núcleo, el núcleo tenía huecos que el segundo hilo usó, que es la explicación del +84 % de SMT.
- Fallos de L1, L2 y L3 por cada mil instrucciones en el listado. Si son pocos, la CPU se va en instrucciones y no en esperar a la memoria, como estima el informe (2,1 % del tiempo).
- Guarda la carpeta de uProf y el reporte en `resultados/_uprof_<fecha>/`, con la versión de uProf y el estado de Hyper-V.
