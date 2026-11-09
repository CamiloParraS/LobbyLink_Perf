#!/usr/bin/env bash
# PRUEBAS PENDIENTES EN EL PC (2026-11-09). Corre, UNA A LA VEZ, las mediciones que cierran limitaciones del informe.
# Ninguna sobrescribe datos: cada corrida va a su carpeta nueva de resultados/ con etiqueta propia.
#
#   paso  qué cierra                                                   entorno          tiempo estimado
#   p3    equivalencia del arreglo: mismas respuestas en los dos jars  PC (mongod)      ~5 min
#   p2    F1 con contador de frecuencia por hilo (login en Windows)    PC, ambos jars   ~1 h 50 (6 endpoints × 360 s × 2 jars)
#         y p6: F1 del PC con más de 30 muestras en los endpoints baratos (mismas corridas)
#   p4    F7 en el contenedor, jar original, con -Xmx700m              docker           ~40 min
#   p8    datos ×10 y ×100 (2.000 y 20.000 lobbies) con predicción     PC y docker      ~1 h 10
#         escrita ANTES, jar corregido
#   p9    datos que no caben en la caché (1,2 GB contra 512 MB)         docker           ~1 h 15 (necesita ~2 GB libres en C:)
#   p7    techo de login (F6 con perfil login) y F6 con mezcla-postman  PC y docker      ~4 h
#   p5    tercera repetición de F6 con el jar corregido                 PC y docker      ~2 h 20
#   Total: ~11 h 20 min. Se puede partir en dos noches con SOLO.
#
# Uso, desde Git Bash como ADMINISTRADOR (para fijar mongod), con el PC sin otros programas abiertos:
#   cd lobbylink_perfv3 && nohup ./campanas/pendientes_local.sh > resultados/_logs/_pendientes.txt 2>&1 &
#   SOLO="p3 p2 p4 p8" ./campanas/pendientes_local.sh        (primera noche, ~3 h 45)
#   SOLO="p9 p7 p5"    ./campanas/pendientes_local.sh        (segunda noche, ~7 h 35)
# Estado: resultados/_logs/_pendientes_estado.txt. No se detiene si un paso falla: anota el código y sigue.
set -u
cd "$(dirname "$0")/.."
EST=resultados/_logs/_pendientes_estado.txt; mkdir -p resultados/_logs
log() { echo "$(date '+%F %T')  $*" | tee -a "$EST"; }
SOLO=${SOLO:-p3 p2 p4 p8 p9 p7 p5}
BASEJ=$(cygpath -w "$(pwd)/jars/disenofinal-base.jar"); FIXJ=$(cygpath -w "$(pwd)/jars/disenofinal-nplus1-fix.jar")

mongod_listo() {   # el PC nativo usa el mongod de Windows en :27017
  (echo > /dev/tcp/127.0.0.1/27017) 2>/dev/null && return 0
  log "arrancando el servicio MongoDB"; net start MongoDB >/dev/null 2>&1
  for k in $(seq 1 30); do (echo > /dev/tcp/127.0.0.1/27017) 2>/dev/null && return 0; sleep 2; done
  log "AVISO: mongod no responde en :27017; los pasos en el PC fallarán"; return 1
}
docker_listo() {
  docker info >/dev/null 2>&1 && return 0
  log "arrancando Docker Desktop"; powershell -NoProfile -Command 'Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"' >/dev/null 2>&1
  for k in $(seq 1 60); do docker info >/dev/null 2>&1 && { sleep 30; return 0; }; sleep 10; done
  log "AVISO: Docker no responde"; return 1
}
paso() { local n=$1; shift; case " $SOLO " in *" $n "*) ;; *) return ;; esac
  log "INICIO $n: $*"; ( eval "$@" ); log "FIN    $n codigo=$?"; sleep 120; }

log "pendientes: $SOLO"
mongod_listo

# p3: equivalencia de respuestas (una base nueva, dos arranques de la app)
paso p3 "node telemetry/comparar_respuestas.mjs"

# p2 + p6: F1 completo con el agente nuevo (cpu.perf / cpu.mhz) y 360 s por endpoint; tablas de frecuencia y modelo nuevo
paso p2 "TAG=v3frec JAR='$BASEJ' F1_SEG=360 FASES=f1 ./campanas/campana.sh windows && TAG=v3fixfrec JAR='$FIXJ' F1_SEG=360 FASES=f1 ./campanas/campana.sh windows; \
  node telemetry/frecuencia.mjs \$(ls -d resultados/*_windows_v3frec-f1-login resultados/*_windows_v3frec-f1-list resultados/*_windows_v3fixfrec-f1-login | tail -3) > resultados/_logs/frecuencia_windows_f1_$(date +%Y%m%d).md"

docker_listo
# p4: misma F7 del contenedor con el jar original, heap fijado en 700 MB (el contenedor sigue con 1 GB)
paso p4 "TAG=v3xmx JAR='$BASEJ' JAVA_OPTS=-Xmx700m BASE_RPS=10 FASES=f7 ./campanas/campana.sh docker"

# p8: datos ×10 y ×100 con el jar corregido; f7d escribe la predicción con el F2 de v3fix antes de cada medición
paso p8 "TAG=v3fix JAR='$FIXJ' BASE_RPS=10 DATOS_N='2000 20000' FASES=f7d ./campanas/campana.sh windows,docker"

# p9: caché de WiredTiger de 256 MB y contenedor de mongod de 512 MB (también limita la caché de páginas), 20.000 contra 400.000 lobbies de ~3 KB
paso p9 "TAG=v3fix JAR='$FIXJ' MONGO_MEM=512m BULK_CALIENTE=20000 BULK_FRIO=400000 FASES=f9 ./campanas/campana.sh docker"

# p7: techo de BCrypt sostenido y mezcla con escrituras, jar corregido, una repetición
paso p7 "TAG=v3fix JAR='$FIXJ' MEZCLA=login ESCALA='2 5 10 20 40 80' REPS=1 NO_PROPIO=1 FASES=f6 ./campanas/campana.sh windows,docker; \
  TAG=v3fix JAR='$FIXJ' MEZCLA=mezcla-postman ESCALA='5 10 20 40 80 160' REPS=1 NO_PROPIO=1 FASES=f6 ./campanas/campana.sh windows,docker"

# p5: tercera repetición de F6 (semilla 3) con el jar corregido; el PC con su escala larga
paso p5 "TAG=v3fix JAR='$FIXJ' ESCALA='5 10 20 40 80 160 320' REP_FROM=3 REPS=3 NO_PROPIO=1 FASES=f6 ./campanas/campana.sh windows; \
  TAG=v3fix JAR='$FIXJ' REP_FROM=3 REPS=3 NO_PROPIO=1 FASES=f6 ./campanas/campana.sh docker"

log "PENDIENTES TERMINADOS"
