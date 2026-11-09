#!/usr/bin/env bash
# F0: techos de la MAQUINA, sin la app. Sirven para comparar lo que la app usa contra lo que el hardware da
# ("la app hace 2 IOPS de 3.000 medidas") y para el laboratorio de la sesion 07 (IOPS reales contra la ficha tecnica).
#
#   bash setup/sondas.sh windows            disco del PC (fio para Windows, motor windowsaio)
#   bash setup/sondas.sh docker             disco de la VM de Docker Desktop (fio dentro de un contenedor alpine con la cuota de mongod)
#   bash setup/sondas.sh linux              disco de la instancia (EBS); se lanza en el SERVIDOR
#   bash setup/sondas.sh iperf <IP>         red generador -> servidor (iperf3 -s debe estar corriendo en <IP>); se lanza en el GENERADOR
#
# Pruebas de disco (archivo de 1 GiB, 60 s cada una, E/S directa sin cache del SO):
#   randread  4 KiB, profundidad 32   -> IOPS de lectura aleatoria (lo que pide una base de datos que no cabe en RAM)
#   syncwrite 4 KiB, profundidad 1, fsync tras cada escritura -> lo que hace el journal de WiredTiger al confirmar una escritura
#   seqread   1 MiB, profundidad 8    -> MB/s secuenciales (copias, respaldos)
# Salida: resultados/<fecha>_<entorno>_sondas/{fio_*.json, iperf.json, sondas.json (resumen)}
set -u
cd "$(dirname "$0")/.."
ENV=${1:?windows|docker|linux|iperf}
STAMP=$(date +%Y%m%d_%H%M%S); OUT=resultados/${STAMP}_${ENV}_sondas; mkdir -p "$OUT"
SECS=${SECS:-60}
COMMON="--size=1g --runtime=$SECS --time_based --direct=1 --group_reporting --output-format=json"
JOBS=("randread|--rw=randread --bs=4k --iodepth=32" "syncwrite|--rw=randwrite --bs=4k --iodepth=1 --fsync=1" "seqread|--rw=read --bs=1m --iodepth=8")

case $ENV in
  windows)
    command -v fio >/dev/null || { echo "Falta fio para Windows (https://github.com/axboe/fio/releases, instalador .msi). Luego repite."; exit 1; }
    for j in "${JOBS[@]}"; do n=${j%%|*}; echo "fio $n ($SECS s)"; (cd "$OUT" && fio --name=$n --filename=fio.tmp --ioengine=windowsaio --thread ${j#*|} $COMMON > fio_$n.json); done
    rm -f "$OUT/fio.tmp" ;;
  docker)
    for j in "${JOBS[@]}"; do n=${j%%|*}; echo "fio $n ($SECS s) en contenedor (cpus ${MONGO_CPUS:-1})"
      docker run --rm --cpus "${MONGO_CPUS:-1}" -v lobbylink_fio:/data alpine:3.20 sh -c "apk add -q fio >/dev/null && cd /data && fio --name=$n --filename=fio.tmp --ioengine=libaio ${j#*|} $COMMON" > "$OUT/fio_$n.json"; done
    docker volume rm lobbylink_fio >/dev/null ;;
  linux)
    command -v fio >/dev/null || sudo apt-get install -y -qq fio >/dev/null
    for j in "${JOBS[@]}"; do n=${j%%|*}; echo "fio $n ($SECS s)"; (cd "$OUT" && fio --name=$n --filename=fio.tmp --ioengine=libaio ${j#*|} $COMMON > fio_$n.json); done
    rm -f "$OUT/fio.tmp" ;;
  iperf)
    IP=${2:?IP del servidor con iperf3 -s}
    command -v iperf3 >/dev/null || sudo apt-get install -y -qq iperf3 >/dev/null
    echo "iperf3 -> $IP (30 s, 4 flujos)"; iperf3 -c "$IP" -t 30 -P 4 -J > "$OUT/iperf.json" ;;
  *) echo "entorno desconocido: $ENV"; exit 1 ;;
esac

command -v node >/dev/null || . ~/.nvm/nvm.sh
node -e '
const fs=require("fs"),d=process.argv[1],o={env:process.argv[2],at:new Date().toISOString()};
for (const f of fs.readdirSync(d)) {
  const j=JSON.parse(fs.readFileSync(d+"/"+f,"utf8").replace(/^[^{]*/,""));
  if (f.startsWith("fio_")) { const job=j.jobs[0], k=f.slice(4,-5), x=job.read.io_bytes?job.read:job.write;
    o[k]={iops:Math.round(x.iops),mbs:+(x.bw_bytes/1048576).toFixed(1),latP50us:Math.round((x.clat_ns?.percentile?.["50.000000"]??0)/1000),latP99us:Math.round((x.clat_ns?.percentile?.["99.000000"]??0)/1000)};
    if (k==="syncwrite" && job.sync?.lat_ns) o[k].fsyncP50us=Math.round((job.sync.lat_ns.percentile?.["50.000000"]??job.sync.lat_ns.mean)/1000); }
  if (f==="iperf.json") o.iperf={mbps:Math.round(j.end.sum_received.bits_per_second/1e6),retransmits:j.end.sum_sent.retransmits};
}
fs.writeFileSync(d+"/sondas.json",JSON.stringify(o,null,2)); console.log(JSON.stringify(o,null,2));' "$OUT" "$ENV"
echo "Resumen en $OUT/sondas.json. Para el modelo: --disk-iops <syncwrite.iops> (escrituras confirmadas) y --net-mbps <iperf.mbps>."
