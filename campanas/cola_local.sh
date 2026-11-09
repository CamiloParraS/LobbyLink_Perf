#!/usr/bin/env bash
# COLA LOCAL: espera a que termine la campaña en curso (PC, jar base) y corre, UNA A LA VEZ, las otras tres:
#   2) PC con el jar del arreglo N+1   3) contenedor con el jar base   4) contenedor con el jar del arreglo N+1
# Ejecutar desde Git Bash como ADMINISTRADOR (mongod fijado en el PC):
#   cd lobbylink_perfv3 && nohup ./campanas/cola_local.sh > resultados/_logs/_cola.txt 2>&1 &
# Variables: ESPERAR=0 (no esperar la campaña en curso), SOLO="2 3" (solo algunas), REPS_FIX (def. 2; campañas 2 y 4), REPS_BASE (def. 3; campaña 3).
# No se detiene si una campaña falla: anota el codigo y sigue. Estado: resultados/_logs/_cola_estado.txt
set -u
cd "$(dirname "$0")/.."
EST=resultados/_logs/_cola_estado.txt
log() { echo "$(date '+%F %T')  $*" | tee -a "$EST"; }
FIX=$(cygpath -w "$(cd .. && pwd)/LobbyLink_backend_nplus1/target/disenofinal-0.0.1-SNAPSHOT.jar")
[ -f "$(cygpath -u "$FIX")" ] || { log "no existe el jar del arreglo: $FIX"; exit 1; }
REPS_FIX=${REPS_FIX:-2}; SOLO=${SOLO:-2 3 4}
# escala del PC con el arreglo: la comun (5-80) mas 160 y 320, porque el codo con el arreglo esta por encima de 80
ESC_PC="5 10 20 40 80 160 320"

if [ "${ESPERAR:-1}" = 1 ]; then
  n0=$(grep -c "TODO TERMINADO" resultados/_logs/_campana_estado.txt)
  log "esperando a que termine la campaña en curso (marcadores TODO TERMINADO: $n0)"
  while [ "$(grep -c 'TODO TERMINADO' resultados/_logs/_campana_estado.txt)" -le "$n0" ]; do sleep 60; done
  log "campaña en curso terminada"; sleep 120
fi

docker_listo() {
  docker info >/dev/null 2>&1 && return 0
  log "arrancando Docker Desktop"; powershell -NoProfile -Command 'Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"' >/dev/null 2>&1
  for k in $(seq 1 60); do docker info >/dev/null 2>&1 && { sleep 30; return 0; }; sleep 10; done
  return 1
}
corre() { local n=$1; shift; case " $SOLO " in *" $n "*) ;; *) return ;; esac
  log "INICIO campaña $n: $*"; ( eval "$@" ); log "FIN    campaña $n codigo=$?"; sleep 180; }

# 2) PC, jar del arreglo. Misma mezcla, semillas y duracion; REPS=2; sin F0 (el hardware no cambia).
corre 2 "TAG=v3fix JAR='$FIX' REPS=$REPS_FIX ESCALA='$ESC_PC' FASES='f1 f2 f3 f5 f6' ./campanas/campana_jar.sh windows"
# 3) contenedor, jar base (todas las fases; f3 se salta sola en docker)
docker_listo || log "AVISO: Docker no responde; las campañas 3 y 4 fallarán"
corre 3 "REPS=${REPS_BASE:-3} ./campanas/campana.sh docker"
# 4) contenedor, jar del arreglo (con F4: el arreglo cambia que proceso limita)
corre 4 "TAG=v3fix JAR='$FIX' REPS=$REPS_FIX FASES='f1 f2 f4 f5 f6' ./campanas/campana_jar.sh docker"
log "COLA TERMINADA"
