#!/usr/bin/env bash
# COPIA de campana.sh con una variable JAR (ruta Windows de otro jar, p. ej. el del arreglo N+1). Por lo demas identica.
# CAMPAÑA v3: las mismas fases F0-F8 en las tres opciones (PC físico, contenedor con límites, nube). Plan y justificación de
# cada valor en docs/PLAN.md. Ningún nivel de carga es un supuesto de uso: F1 mide el costo de cada endpoint, el modelo
# (telemetry/model.mjs) predice el techo X_max, la rampa F5 se arma como fracciones de ese X_max medido, y la comparación F6
# usa la misma escala absoluta de req/s en las tres máquinas.
#
#   fase  carga                                                          responde
#   f0    sin app: fio (disco) e iperf3 (red, solo EC2)                  techos del hardware contra los que se compara el uso
#   f1    bucle cerrado, 1 worker, un endpoint por corrida, 120 s         D: ms de CPU (app, mongod), E/S y bytes por petición -> "¿por qué ese número?"
#   f2    listado con 100/200/400/800/1600 lobbies, 1 worker              crecimiento del costo con los datos (N+1 doble, exponente)
#   f3    bucle cerrado 1..2×hilos workers, listar y login               Amdahl: fracción paralela p, ganancia de SMT (sesión 05)
#   f4    (solo docker) cuotas app×mongod, bucle cerrado 1/4/16           qué proceso limita; frenado (throttled) de la cuota CFS
#   f5    tasa fija, 10 %..150 % del X_max predicho, 2 mezclas            codo medido vs predicho (valida el modelo)
#   f6    tasa fija, MISMA escala en todas las máquinas, 600 s, REPS      tabla comparativa: CPU, RSS, IOPS, MB/s, red, p50/p95/p99
#   f7    10 × BASE_RPS y datos ×10 a BASE_RPS (predicción escrita antes) "si la carga se multiplicara por diez"
#   f8    BASE_RPS durante 40 min (pensada para la t3: créditos de CPU)   efectos de tiempo: créditos, crecimiento de memoria
#
# PC (Git Bash; terminal de ADMINISTRADOR para fijar mongod):
#   nohup ./campanas/campana.sh windows,docker > resultados/_logs/_campana.txt 2>&1 &
#   FASES="f0 f1" ./campanas/campana.sh windows                     (solo algunas fases)
#   BASE_RPS=12 FASES="f7" ./campanas/campana.sh windows,docker    (f7/f8 necesitan BASE_RPS: se decide con los datos de f6)
# EC2 (en el GENERADOR, dentro de tmux):
#   ./campanas/campana.sh ec2 <IP_PRIVADA_SERVIDOR> <etiqueta>      luego en el PC: ./campanas/recoger_ec2.sh <IP_PUB_GENERADOR> <etiqueta>
#
# Variables: FASES (def. "f0 f1 f2 f3 f4 f5 f6"), REPS (def. 3, solo f6), ESCALA (def. "5 10 20 40 80", req/s de f6),
#   MEZCLA (def. mezcla-lectura), BASE_RPS (f7, f8), WORKERS_AMDAHL (def. según hilos), TAG (def. v3),
#   APP_CPUS APP_MEM MONGO_CPUS MONGO_MEM (contenedor, def. 1 / 1g / 1 / 1g), CUOTAS (f4, def. "1x0.5 1x1 1x2 1x4 2x1 4x1"),
#   MODEL_POOL (CPU para el modelo; t3 Standard: 0.4), LARGO_RPS (λ de f8; def. BASE_RPS),
#   QUICK=1 (fases cortas: SOLO humo, no van al informe), STRICT=1 (cancela si el PC no está en reposo).
set -u
cd "$(dirname "$0")/.."   # raíz de lobbylink_perfv3
FASES=${FASES:-f0 f1 f2 f3 f4 f5 f6}; REPS=${REPS:-3}; ESCALA=${ESCALA:-5 10 20 40 80}; MEZCLA=${MEZCLA:-mezcla-lectura}; TAG=${TAG:-v3}
CUOTAS=${CUOTAS:-1x0.5 1x1 1x2 1x4 2x1 4x1}
# MODEL_POOL: CPU que el modelo da por disponibles en vez de los hilos de la máquina. Para una t3 en modo Standard sin créditos
# es la línea base de la ficha (t3.small: 2 vCPU × 20 % = 0.4); así la rampa F5 se centra en el techo real y F5 comprueba esa cifra.
MP=${MODEL_POOL:+--pool $MODEL_POOL}
if [ -n "${QUICK:-}" ]; then T1=30; T2=30; T3=20; T5=30; T6=60; T8=120; WU=10; else T1=120; T2=90; T3=60; T5=90; T6=600; T8=2400; WU=20; fi
F1_OPS="list view login register create join"
prof() { case $1 in login) echo login ;; *) echo solo-$1 ;; esac; }
csv() { echo "$*" | tr ' ' ','; }

MODO=${1:-windows,docker}
R=resultados; mkdir -p $R/_logs; EST=$R/_logs/_campana_estado.txt
estado() { echo "$(date '+%F %T')  $*" | tee -a "$EST"; }

# ------------------------------------------------------------------ cómo se corre UNA medición en cada modo
# corre <entorno> <etiqueta> <args para run.mjs / generador>
if [ "$MODO" = ec2 ]; then
  SRV="${2:?IP privada del servidor}"; TAG="${3:?etiqueta, p. ej. t3small}"; KEY=~/.ssh/lobbylink-perf.pem
  . ~/.nvm/nvm.sh >/dev/null
  RES=~/res/$TAG; mkdir -p "$RES/_logs"; R=$RES; EST=$R/_logs/_campana_estado.txt
  S() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 ubuntu@"$SRV" "$@"; }
  HW=$(S 'echo $(lscpu -p=CORE | grep -v "#" | sort -u | wc -l) $(nproc)')   # núcleos físicos e hilos del servidor
  corre() { local lab=$2; shift 2; local d=$RES/$lab; mkdir -p "$d"
    estado "INICIO ec2 $lab"
    S ". ~/.nvm/nvm.sh; tmux kill-session -t srv 2>/dev/null; cd ~/lobbylink_perfv3 && tmux new -d -s srv 'node telemetry/run.mjs --env linux --server-only --jar ~/app.jar --label $TAG-$lab > ~/srv_$TAG-$lab.log 2>&1'"
    for k in $(seq 1 90); do curl -s -o /dev/null --max-time 2 "http://$SRV:8080/api/videojuegos" && break; sleep 2; done
    sleep 25   # el agente toma muestras en reposo (model.mjs las usa como línea base)
    local gen=telemetry/load.mjs; case " $* " in *" --rates "*) gen=telemetry/rate.mjs ;; esac
    node $gen --base "http://$SRV:8080" "$@" --env "linux-$TAG-$lab" --out "$d/load.ndjson" > "$d/load.txt" 2>&1
    tail -4 "$d/load.txt"
    S "tmux send-keys -t srv C-c"; for k in $(seq 1 30); do S "tmux has-session -t srv" 2>/dev/null || break; sleep 2; done
    local sd; sd=$(S "ls -d ~/lobbylink_perfv3/resultados/*_linux_$TAG-$lab 2>/dev/null | tail -1")
    [ -n "$sd" ] && S "cd $sd && tar cf - agent.ndjson run.json app.log 2>/dev/null" | tar xf - -C "$d"
    estado "FIN    ec2 $lab"; sleep ${PAUSA:-120}; }
  ultimo() { echo "$RES/$2"; }                     # carpeta de la última corrida con esa etiqueta
  ENVS=ec2
else
  limpiar() { docker ps -aq --filter "name=lobbylink" | xargs -r docker rm -f >/dev/null 2>&1; }
  corre() { local env=$1 lab=$2; shift 2; local extra=""
    [ $env = docker ] && { extra="--app-cpus ${ACPU:-${APP_CPUS:-1}} --app-mem ${APP_MEM:-1g} --mongo-cpus ${MCPU:-${MONGO_CPUS:-1}} --mongo-mem ${MONGO_MEM:-1g}"; limpiar; }
    estado "INICIO $env $lab"
    node telemetry/run.mjs --env $env --label $lab "$@" ${STRICT:+--strict-idle} $extra ${JAR:+--jar "$JAR"} --results $R > $R/_logs/_${env}_${lab}.txt 2>&1
    local rc=$?; [ $env = docker ] && limpiar
    estado "FIN    $env $lab codigo=$rc"; sleep ${PAUSA:-120}; }
  ultimo() { ls -d $R/*_${1}_$2 2>/dev/null | tail -1; }
  ENVS=${MODO//,/ }
  # En el PC run.mjs fija app (y mongod si hay permisos) en 2/3 de los hilos: con 12 hilos, 8 hilos = 4 núcleos con SMT
  HW=$(node -p 'const n=require("os").cpus().length, t=Math.floor(n*2/3); (t/2)+" "+t')
fi
# Amdahl: 1, 2, 4 ... hasta el doble de los hilos del servidor (sesión 05), pasando por núcleos físicos e hilos
CORES=${HW% *}; THREADS=${HW#* }
WA=${WORKERS_AMDAHL:-$(node -e 'const c=+process.argv[1],n=+process.argv[2],s=new Set([1,2,4,c,n,n*2].filter(x=>x>=1&&Number.isInteger(x)));for(let k=8;k<n*2;k*=2)s.add(k);console.log([...s].sort((a,b)=>a-b).join(","))' $CORES $THREADS)}

for env in $ENVS; do
  case $env in windows|docker|ec2) ;; *) echo "entorno desconocido: $env"; exit 1 ;; esac
  pre=$TAG; [ $env = docker ] && pre=$TAG-a${APP_CPUS:-1}m${MONGO_CPUS:-1}
  [ $env = ec2 ] && pre=x                                # en ec2 la etiqueta ya va en la carpeta ~/res/<etiqueta>
  lb() { [ $env = ec2 ] && echo "$1" || echo "$pre-$1"; }   # etiqueta de corrida
  f1dirs() { for op in $F1_OPS; do ultimo $env "$(lb f1-$op)"; done; }
  for fase in $FASES; do case $fase in
  f0)
    if [ $env = ec2 ]; then
      S ". ~/.nvm/nvm.sh; cd ~/lobbylink_perfv3 && bash setup/sondas.sh linux" | tail -3
      S "pkill iperf3; iperf3 -s -D"; mkdir -p $RES/f0
      iperf3 -c "$SRV" -t 30 -P 4 -J > $RES/f0/iperf.json; S "pkill iperf3"
      sd=$(S "ls -d ~/lobbylink_perfv3/resultados/*_linux_sondas | tail -1"); S "cd $sd && tar cf - *.json" | tar xf - -C $RES/f0
    else
      estado "F0 sondas $env"; bash setup/sondas.sh $env > $R/_logs/_${env}_f0.txt 2>&1 || estado "F0 $env falló (¿falta fio?): ver $R/_logs/_${env}_f0.txt"
    fi ;;
  f1)
    for op in $F1_OPS; do u=20; [ $op = join ] && u=100   # 100 usuarios × 200 lobbies = 20.000 pares distintos para unirse
      corre $env "$(lb f1-$op)" --profile $(prof $op) --workers 1 --seconds $T1 --warm $WU --users $u; done
    node telemetry/model.mjs $(f1dirs) $MP > $R/_logs/modelo_${env}_$(lb f1).md 2>&1; estado "modelo F1 -> $R/_logs/modelo_${env}_$(lb f1).md" ;;
  f2)
    for n in 100 200 400 800 1600; do corre $env "$(lb f2-list-$n)" --profile solo-list --workers 1 --seconds $T2 --warm $WU --lobbies $n; done
    node telemetry/model.mjs --sweep $(for n in 100 200 400 800 1600; do ultimo $env "$(lb f2-list-$n)"; done) > $R/_logs/datos_${env}_$(lb f2).md 2>&1 ;;
  f3)
    [ $env = docker ] && continue   # con cuota de 1 CPU no hay nada que escalar; las cuotas se estudian en f4
    for p in solo-list login; do corre $env "$(lb f3-$p)" --profile $p --workers $WA --seconds $T3 --warm 15 --pause 10; done
    node telemetry/amdahl.mjs --cores $CORES --threads $THREADS $(ultimo $env "$(lb f3-solo-list)") $(ultimo $env "$(lb f3-login)") > $R/_logs/amdahl_${env}_$(lb f3).md 2>&1 ;;
  f4)
    [ $env = docker ] || continue
    for c in $CUOTAS; do ACPU=${c%x*} MCPU=${c#*x} corre docker "$TAG-f4-a${c%x*}m${c#*x}" --profile $MEZCLA --workers 1,4,16 --seconds $T3 --warm 15 --pause 10; done ;;
  f5)
    for mz in mezcla-lectura mezcla-postman; do
      X=$(node telemetry/model.mjs $(f1dirs) $MP --xmax $mz) || { estado "F5 $env: no hay X_max para $mz (¿corrió f1?)"; continue; }
      rates=$(node -e 'const x=+process.argv[1];const r=[];for(let k=1;k<=15;k++)r.push(Math.max(0.5,Math.round(x*k/10*10)/10));console.log([...new Set(r)].join(","))' $X)
      estado "F5 $env $mz: X_max predicho $X req/s -> λ = $rates"
      corre $env "$(lb f5-$mz)" --profile $mz --rates $rates --seconds $T5 --warm $WU --pause 20 --stop-after-fail 2 --timeout 10
    done
    node telemetry/model.mjs $(f1dirs) $MP --validate $(ultimo $env "$(lb f5-mezcla-lectura)") --validate $(ultimo $env "$(lb f5-mezcla-postman)") > $R/_logs/validacion_${env}_$(lb f5).md 2>&1 ;;
  f6)
    for i in $(seq 1 $REPS); do
      corre $env "$(lb f6-$MEZCLA-r$i)" --profile $MEZCLA --rates $(csv $ESCALA) --seconds $T6 --warm 30 --pause 60 --stop-after-fail 1 --timeout 10 --seed $i
    done
    # y cada máquina al 50 % y 80 % de SU codo medido en f5 (qué le sobra cuando está holgada / casi llena)
    K=$(node telemetry/knee.mjs $(ultimo $env "$(lb f5-$MEZCLA)") 2>/dev/null) && corre $env "$(lb f6-propio)" --profile $MEZCLA \
      --rates $(node -p "[0.5,0.8].map(f=>Math.round($K*f*10)/10).join(',')") --seconds $T6 --warm 30 --pause 60 --timeout 10 ;;
  f7)
    [ -n "${BASE_RPS:-}" ] || { estado "F7 $env: falta BASE_RPS (elegirlo con los datos de f6; ver docs/PLAN.md)"; continue; }
    P=$R/_logs/prediccion_x10_${env}_$(date +%Y%m%d_%H%M%S).md   # se escribe ANTES de medir: la marca de tiempo lo prueba
    node telemetry/model.mjs $(f1dirs) $MP --base-rps $BASE_RPS ${NET_MBPS:+--net-mbps $NET_MBPS} ${DISK_IOPS:+--disk-iops $DISK_IOPS} > $P 2>&1; estado "predicción ×10 -> $P"
    X10=$(node -p "Math.round($BASE_RPS*10*10)/10")
    corre $env "$(lb f7-trafico-x10)" --profile $MEZCLA --rates $BASE_RPS,$X10 --seconds $T6 --warm 30 --pause 60 --timeout 10
    corre $env "$(lb f7-datos-x10)" --profile $MEZCLA --rates $BASE_RPS --lobbies 2000 --seconds $T6 --warm 30 --timeout 10 ;;
  f8)
    [ -n "${BASE_RPS:-}" ] || { estado "F8 $env: falta BASE_RPS"; continue; }
    corre $env "$(lb f8-largo)" --profile $MEZCLA --rates ${LARGO_RPS:-$BASE_RPS} --seconds $T8 --warm 30 --timeout 10 ;;
  *) estado "fase desconocida: $fase" ;;
  esac; done
done
estado "TODO TERMINADO ($MODO: $FASES)"
