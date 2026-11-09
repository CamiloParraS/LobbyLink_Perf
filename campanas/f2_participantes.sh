#!/usr/bin/env bash
# F2b: costo del listado contra los PARTICIPANTES POR LOBBY (lobbies fijos en 200). Responde al límite de la guía:
# "cada lobby sembrado tiene un solo participante; con más, el conteo del jar base recorre una colección más grande".
# Mide solo F2 (1 worker, solo listar), con el jar base y el arreglado, para ver cuánto sube el costo del base con P y que el
# arreglado no depende de P. No sustituye a campana.sh: cuando haya tiempo se puede invocar desde ahí (FASES="f2p").
#
#   ./campanas/f2_participantes.sh                      windows, jar base y arreglado, P = 1 5 20 50 100
#   ./campanas/f2_participantes.sh docker               en contenedor (APP_CPUS/APP_MEM/MONGO_CPUS/MONGO_MEM, def. 1 / 1g / 1 / 1g)
#   PS="1 10 50" JARS=base ./campanas/f2_participantes.sh windows
#
# Variables: PS (participantes, def. "1 5 20 50 100"), JARS (def. "base fix"), LOBBIES (def. 200), SECS (def. 90), WARM (def. 20),
#   PAUSA (s entre corridas, def. 60), TAG (def. v3), QUICK=1 (SECS=30, WARM=10, PAUSA=20: solo humo, no va al informe), STRICT=1.
# Requiere mongod local (windows) o Docker (docker). Una base de Mongo nueva por corrida (la hace run.mjs).
set -u
cd "$(dirname "$0")/.."   # raíz de lobbylink_perfv3
ENV=${1:-windows}; case $ENV in windows|docker) ;; *) echo "uso: $0 [windows|docker]"; exit 1 ;; esac
PS=${PS:-1 5 20 50 100}; JARS=${JARS:-base fix}; LOBBIES=${LOBBIES:-200}; TAG=${TAG:-v3}
if [ -n "${QUICK:-}" ]; then SECS=30; WARM=10; PAUSA=${PAUSA:-20}; else SECS=${SECS:-90}; WARM=${WARM:-20}; PAUSA=${PAUSA:-60}; fi
R=resultados; mkdir -p $R/_logs
jar() { case $1 in base) echo jars/disenofinal-base.jar ;; fix) echo jars/disenofinal-nplus1-fix.jar ;; *) echo "jar desconocido: $1" >&2; exit 1 ;; esac; }
pre=$TAG; [ $ENV = docker ] && pre=$TAG-a${APP_CPUS:-1}m${MONGO_CPUS:-1}
dockerx=""; [ $ENV = docker ] && dockerx="--app-cpus ${APP_CPUS:-1} --app-mem ${APP_MEM:-1g} --mongo-cpus ${MONGO_CPUS:-1} --mongo-mem ${MONGO_MEM:-1g}"
limpiar() { [ $ENV = docker ] && docker ps -aq --filter "name=lobbylink" | xargs -r docker rm -f >/dev/null 2>&1; }
ultimo() { ls -d $R/*_${ENV}_$1 2>/dev/null | tail -1; }
EST=$R/_logs/_campana_estado.txt
estado() { echo "$(date '+%F %T')  $*" | tee -a "$EST"; }

for j in $JARS; do
  JAR=$(jar $j); [ -f "$JAR" ] || { echo "no existe $JAR"; exit 1; }
  dirs=""
  for p in $PS; do
    lab="$pre-f2p-$j-p$p"
    limpiar; estado "INICIO $ENV $lab (jar $j, $LOBBIES lobbies, $p participantes por lobby)"
    node telemetry/run.mjs --env $ENV --label $lab --jar "$JAR" --profile solo-list --workers 1 --seconds $SECS --warm $WARM \
      --lobbies $LOBBIES --participants $p --users $(( p > 20 ? p : 20 )) ${STRICT:+--strict-idle} $dockerx --results $R > $R/_logs/_${ENV}_${lab}.txt 2>&1
    rc=$?; limpiar; estado "FIN    $ENV $lab codigo=$rc"
    d=$(ultimo $lab); [ -n "$d" ] && dirs="$dirs $d"
    sleep $PAUSA
  done
  out=$R/_logs/datos_${ENV}_${pre}-f2p-$j.md
  node telemetry/model.mjs --sweep --by participants $dirs > $out 2>&1; estado "F2b $j -> $out"
done
echo; echo "Tablas en $R/_logs/datos_${ENV}_${pre}-f2p-*.md (una por jar). Compara la columna 'ms CPU total' y el exponente entre base y fix."
