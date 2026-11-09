#!/usr/bin/env bash
# Trae al PC los datos de una campaña v3 en AWS. En v3 la campaña ya junta todo en el GENERADOR: tras cada corrida copia
# agent.ndjson, run.json y app.log del servidor junto a load.ndjson, en ~/res/<etiqueta>/<corrida>/.
# Uso (Git Bash): ./campanas/recoger_ec2.sh <IP_PUBLICA_GENERADOR> <etiqueta> [llave.pem]
# Resultado: resultados/ec2_<etiqueta>/<corrida>/{load.ndjson,load.txt,agent.ndjson,run.json,app.log}, f0/ (sondas), _logs/ (modelo, Amdahl, predicción)
# No sobrescribe: falla si la carpeta ya existe.
set -u
cd "$(dirname "$0")/.."
GEN="$1"; TAG="$2"; KEY="${3:-$HOME/.ssh/lobbylink-perf.pem}"
OUT="resultados/ec2_$TAG"; [ -e "$OUT" ] && { echo "ya existe $OUT; no se sobrescribe"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
for i in 1 2 3 4; do
  ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=15 ubuntu@"$GEN" "cd ~/res && tar czf - $TAG" > "$TMP/g.tgz" 2>/dev/null \
    && tar tzf "$TMP/g.tgz" >/dev/null 2>&1 && break
  echo "reintento $i"; sleep 5
done
tar tzf "$TMP/g.tgz" >/dev/null 2>&1 || { echo "no se pudo traer el generador"; exit 1; }
mkdir -p resultados && tar xzf "$TMP/g.tgz" -C "$TMP" && mv "$TMP/$TAG" "$OUT"
for d in "$OUT"/*/; do echo "ok $(basename "$d"): $(ls "$d" | tr '\n' ' ')"; done
echo "Siguiente: node telemetry/model.mjs $OUT/f1-* ; node telemetry/report.mjs $OUT/f6-*"
