# Handoff: lobbylink_perfv3

**Estado vigente: sección 11 (2026-11-09).** Lo anterior es historia y contexto.

Corte original: 2026-11-05. Para el agente que siga. Léelo en este orden: este archivo → `docs/PLAN.md` (método y por qué de cada valor) → `README.md` (comandos) → `setup/EC2.md` (AWS). Contexto del curso y reglas generales: `../CLAUDE.md`. Enunciado: <https://sitio-production-fdff.up.railway.app/computacional/proyecto.html>.

## 1. Qué es y por qué existe

Laboratorio de mediciones para decidir en qué máquina corre LobbyLink (PC físico, contenedor con límites, EC2). v2 (`../lobbylink_perfv2`) generaba carga con un modelo de usuarios cuyos parámetros eran **supuestos** (sesión 120 s, pausa 8 s, mezcla 75/15/10, 70 % con token, niveles 60-1.200 usuarios). El usuario lo considera inaceptable: en la sustentación preguntan "¿por qué ese número?". **Regla de v3: no introducir ningún número de carga que no salga de una medición, del código o del único requisito declarado** (p95 ≤ 1.000 ms y errores ≤ 1 %, `telemetry/profiles/umbrales.json`). Si te ves eligiendo un número, derívalo o decláralo como tal en `docs/PLAN.md`.

La cadena del método:
F1 mide D (ms de CPU de app y de `mongod` por petición, cada endpoint aislado, 1 worker) → `model.mjs` predice X_max = CPU / Σ pᵢ·Dᵢ → F5 rampa a tasa fija en 10-150 % de X_max (valida la predicción) → F6 sostenida con la misma escala absoluta (5, 10, 20, 40, 80 req/s) en todas las máquinas → F7 ×10 con predicción escrita antes de medir → F8 efectos de tiempo (créditos t3). El usuario **no** tiene tiempo de medir tráfico real (descartado; no lo propongas de nuevo).

## 2. Estado (HISTÓRICO, corte 2026-11-05; el estado vigente está en la sección 8)

- **Código completo**, sin errores de sintaxis. Probado en el PC solo con humo (`resultados/_humo/`, no va al informe): una F1 de listado (`load.mjs` + `model.mjs`) y una corrida a tasa fija (`rate.mjs` + `report.mjs` + `model.mjs --validate`). Todo funcionó.
- **Sin probar:** la campaña completa (`campanas/campana.sh`) en cualquier modo, el modo `ec2` (corregí 4 errores leyendo el código, pero nunca se ha ejecutado), `setup/sondas.sh` (falta `fio` en el PC), F4 (docker), `amdahl.mjs` y `knee.mjs` con datos reales.
- **No hay corridas reales de v3.** No es repo git (v2 sí lo es).
- Dato de humo (20 s, reposo sucio, `mongod` sin fijar; solo para comprobar que el modelo tiene sentido): listado con 200 lobbies = 5,4 req/s a 1 worker, p50 186 ms, 116 ms de CPU de la app + 150 ms de `mongod` por petición, 34,6 KB. X_max predicho con 12 hilos = 45 req/s; v2 midió 41 con `readonly`. Coincide.

## 3. Siguiente paso: AWS — **HECHO** (campañas EC2 completas y instancias terminadas el 2026-11-07; ver sección 8)

Plan en `setup/EC2.md`: dos parejas en paralelo, cada una con un servidor t3.small y su generador c7i-flex.large. A = **Unlimited** (todas las fases); B = **Standard** (`MODEL_POOL=0.4`, `ESCALA="1 2 5 10 20"`, `REPS=2`, F0 F1 F5 F6, y F8 como medición de cuánto dura la ráfaga tras 60 min de reposo; predicción ≈ 15 min).
1. Comprobar que no siguen encendidas las instancias de v2 (`../lobbylink_perfv2/HANDOFF.md`) y terminarlas. Usar instancias nuevas.
2. Humo en cada pareja (paso 3 de `setup/EC2.md`). Si falla, mira `~/srv_<etiqueta>-<corrida>.log` en el servidor y `~/res/<etiqueta>/<corrida>/load.txt` en el generador.
3. Campaña real, elegir `BASE_RPS` con F6 (regla en `docs/PLAN.md`, "Regla de recomendación"), F7/F8.
4. `./campanas/recoger_ec2.sh <IP_PUB_GEN> <etiqueta>` (una por pareja), capturas de CloudWatch (`CPUCreditBalance`, `CPUSurplusCreditsCharged`…) y **Terminate** de las 4 instancias.
5. Verificar en la página oficial de AWS y anotar con fecha: 24 créditos/h y 20 % de línea base de la t3.small, precio del crédito excedente y precio por hora de cada instancia. En los documentos esas cifras vienen de la ficha, no se midieron.

Después: PC y contenedor (`./campanas/campana.sh windows,docker`, terminal de **administrador**, instalar `fio` para Windows antes), luego F7, arreglo del N+1 (ver 7) e informe. **Hecho** salvo el informe (ver sección 8).

## 4. Mapa del código

```
telemetry/
  rate.mjs          generador de tasa fija (principal). Poisson con semilla (lib rng), latencia desde la hora PROGRAMADA,
                    timeouts y descartes cuentan como error con latencia = timeout, genLag (retraso propio; p99 > 50 ms => genOk=false,
                    el nivel no vale), passAt para cada p95 de umbrales.sensibilidadP95Ms, --stop-after-fail N
  load.mjs          bucle cerrado (N workers). Solo F1 (1 worker) y F3 (Amdahl). Registra respBytes por operación
  lib/lobbylink.mjs client() con contador de bytes, seed() (1 videojuego, --users, --lobbies, un solo cliente: latencia base),
                    makeOps() (list, view, create, join, login, register; join recorre pares usuario-lobby SIN repetir),
                    picker(mix, rnd), rng(seed) = mulberry32
  run.mjs           orquesta UNA corrida: base Mongo nueva, app (nativa o docker compose), afinidad en Windows (app y mongod
                    en 2/3 de los hilos, generador en el resto), agente, reposo (idle.json), generador. --rates => rate.mjs; si no, load.mjs.
                    --server-only (EC2): solo app + agente hasta Ctrl+C
  agent.mjs         telemetría (sin cambios desde v2): líneas {t:'machine'}, {t:'s'} (cpu.busy/user/system/iowait/steal, cores[],
                    app/mongo/gen {cpu en % de 1 núcleo, rssMB}, disk.iops/mbs/util, net, cgroup.throttledMs, app/mongo.cpuMax en docker),
                    {t:'m'} (serverStatus de mongod: find, agg, docsExam, cacheMB, missPct…). Backends windows (win-sampler.ps1), linux, docker
  model.mjs         D por endpoint = (CPU media en la ventana − CPU en reposo)/req/s, usando el PRIMER step de cada corrida F1.
                    Capacidad: docker = cuota CFS por contenedor (app y mongod separados); windows = hilos fijados si mongod quedó
                    fijado, si no todos; linux = vCPU; --pool N la reemplaza. Reposo: idle.json o, si no hay (EC2), muestras anteriores
                    a la siembra. Opciones: --xmax <mezcla> (solo imprime el número; la campaña lo usa), --base-rps, --net-mbps,
                    --disk-iops, --sweep (exponente log-log del listado contra lobbies), --validate <corridas rate>, --lobbies (cuál F1 de
                    list usar, def. 200), --mixes
  amdahl.mjs        S(N)=X(N)/X(1), p(N)=(1−1/S)/(1−1/N), mediana, techo 1/(1−p), ganancia de SMT. --cores/--threads
  knee.mjs          mayor req/s logrado entre los niveles de una rampa que pasan (y genOk)
  report.mjs        tablas por corrida (de v2) + sección "Tasa fija" + fila steal
  profiles/         solo-{list,view,register,create,join}, login (F1); mezcla-lectura (list 1, view 1) y mezcla-postman (register,
                    login, create, list, view, join, 1 cada uno): las dos salen de LobbyLink_Postman_Collection.json, el campo
                    "origen" lo explica; umbrales.json
setup/sondas.sh     F0: fio (randread 4K QD32, escritura 4K con fsync QD1, lectura secuencial 1M QD8; 60 s, 1 GiB) e iperf3 -> sondas.json
setup/ec2-preparar.sh  Java 21, Docker + mongo:7 (red del host), Node 22 (nvm), fio, iperf3
campanas/campana.sh F0-F8. Modos windows|docker|windows,docker (PC) y ec2 <IP_PRIVADA> <etiqueta> (se ejecuta EN el generador).
                    Variables: FASES REPS ESCALA MEZCLA BASE_RPS LARGO_RPS MODEL_POOL WORKERS_AMDAHL TAG CUOTAS APP_CPUS
                    APP_MEM MONGO_CPUS MONGO_MEM QUICK STRICT PAUSA
campanas/recoger_ec2.sh  un tar de ~/res/<etiqueta> del generador -> resultados/ec2_<etiqueta>/
```

Formato de `load.ndjson`: `meta` (mode closed|rate, profile completo, thresholds, startedAtMs) · `seed` (users, lobbies, seconds, latencias base) · `mark` · `sec` (por segundo) · `step` (por nivel: workers o rate, measureFrom/end en ms de época, rps, lat {n,p50,p95,p99,max}, byOp, codes, respBytes; en rate además offeredRps, achievedRatio, latService, genLag, genOk, timeouts, drops, maxInflight, passAt, lobbiesStart/lobbiesNow) · `end`. Las ventanas del agente se cruzan con `measureFrom`/`end`. Los histogramas son logarítmicos con error ≤ 4 % (`lib/hist.mjs`).

Salida: PC `resultados/<fecha>_<entorno>_<etiqueta>/`, con etiquetas `v3-f1-list`, `v3-a1m1-f6-mezcla-lectura-r2`, `v3-f4-a1m0.5` (docker) …; tablas automáticas en `resultados/_logs/` (`modelo_*`, `datos_*`, `amdahl_*`, `validacion_*`, `prediccion_x10_<marca>.md`) y estado en `resultados/_logs/_campana_estado.txt`. EC2: `~/res/<etiqueta>/<corrida>/` en el generador (la campaña copia ahí `agent.ndjson`, `run.json` y `app.log` del servidor tras cada corrida).

## 5. Decisiones que no hay que deshacer

- Tasa fija en req/s, no usuarios. Little solo como conversión posterior.
- Bucle cerrado solo en F1 y F3.
- La comparación sostenida usa `mezcla-lectura`: `mezcla-postman` crea lobbies y el listado se encarece durante la corrida (crecimiento cuadrático; el reporte muestra lobbies inicio → fin). `mezcla-postman` va en la rampa F5 como segunda validación.
- Misma escala absoluta en todas las máquinas. En Standard se extiende hacia abajo (1, 2), conservando 5-20 como puntos comunes.
- No se fuerza un escenario de disco sin caché: los datos ocupan pocos MB contra ≥ 256 MB de caché de WiredTiger, y con el N+1 cuadrático una colección suficientemente grande haría que un solo listado tardara minutos. Se explica con fallos de caché ≈ 0 %. El disco solo aparece en el journal (comparar con el `syncwrite` de `fio`).
- Amdahl en el PC con 4 núcleos y 8 hilos (la afinidad deja la app en 0-7). En docker no se corre F3 (lo cubre F4). En Standard tampoco.

## 6. Trampas conocidas

- Windows: fijar `mongod` exige terminal de administrador. Sin eso `run.json → pinned.mongod` dice FALLO y el modelo usa los 12 hilos (compartidos con el generador). El retraso del generador p99 ≈ 16 ms es la resolución del temporizador de Windows; es normal.
- El reposo del PC dio entre 6 y 10 % de CPU (límite 5 %): cerrar programas o usar `STRICT=1`.
- MongoDB 9.0.4 en el PC frente a `mongo:7` en el contenedor y en EC2.
- No usar `pkill -f app.jar` dentro de un `ssh` cuyo texto contenga ese patrón. `tar` en Git Bash necesita `--force-local` con rutas `C:`.
- Lanzar campañas y corridas en segundo plano con la salida a archivo, nunca con `| tail`. Nunca dos corridas a la vez en el PC. No sobrescribir datos crudos. No imprimir `jwt.secret`.
- Si F1-join agota los pares (pasa de 20.000 peticiones), vuelve a empezar y mide el 400 de "ya unido". Revisa `codes`.
- Con `QUICK=1` las muestras del agente son pocas (model.mjs avisa con "Muestras < 30"). Nada de `QUICK` va al informe.

## 7. Pendiente después de las mediciones (actualizado el 2026-11-07)

- **[HECHO]** Arreglo del N+1 doble de `LobbyServiceImpl.toSummaryDto` (`findById` del videojuego + `countByLobbyId` sin índice en `participaciones.lobbyId`) en una rama aparte de `LobbyLink_backend`, medido con `run.mjs --jar <otro jar>` en F1 y F2, antes y después. Es prueba adicional, no cambia la base de comparación. Resultado: `jars/disenofinal-nplus1-fix.jar`, medido en F1-F7 en PC, Docker y EC2 (etiquetas `v3fix-*` y `*-nplus1`); detalle en la sección 8. El arreglo agrupa `countByLobbyId` en una sola agregación y usa `findAllById` para los videojuegos; **no** añade índice en `participaciones.lobbyId`.
- **[PENDIENTE]** Informe (6-10 páginas): tabla F6 con ficha y precio, costo por 1.000 peticiones (fórmulas en `docs/PLAN.md`), respuestas a las 4 preguntas (tabla en `docs/PLAN.md`). Cada afirmación debe citar el número exacto y la carpeta de la que sale.

## 8. Estado al 2026-11-07 (fin de las mediciones)

**Todas las corridas están hechas** en `resultados/`: PC (`windows`), Docker (`a1m1`: app y `mongod` con 1 CPU / 1 GB cada uno) y EC2 (`ec2_t3small-unl`, `-std` y variantes `-nplus1`). Dos jars: `jars/disenofinal-base.jar` y `jars/disenofinal-nplus1-fix.jar` (etiquetas `v3-*` = base, `v3fix-*` = arreglado). Las instancias EC2 ya están terminadas (confirmado por el usuario).

**Resultados clave**
- Dónde espera: CPU, sobre todo `mongod`. Windows, jar base: `mongod` 568-636 % de un núcleo contra 139-192 % de la app; disco en reposo.
- Causa: N+1 de `LobbyServiceImpl.toSummaryDto` (`countByLobbyId` sin índice en `participaciones.lobbyId` + `findById` por lobby). Con 2.000 lobbies cada consulta examina ~2.000 documentos: el costo crece con el cuadrado de los lobbies.
- F7 (×10): el jar base falla a 100 req/s y con 2.000 lobbies en las tres opciones (100 % y 99,18 % de errores; p95 = 10.181 ms es el tope del timeout de 10 s, por eso los números coinciden entre entornos). El jar arreglado pasa todo con 0 errores (Windows: p95 19,93 ms a 100 req/s y 45,42 ms con 2.000 lobbies).
- Docker, λ = 10, base contra arreglado: p95 424,72 ms contra 22,42 ms; frenado CFS máximo 12.981 ms contra 997 ms.
- Red (Docker, corridas nuevas): jar base envía ~79 KB por petición desde el contenedor de la app, el arreglado ~22 KB (la diferencia son las consultas N+1 a `mongod`). La red queda en pocos MB/s: no es el cuello.

**Cambios hechos el 2026-11-07**
- `telemetry/agent.mjs:126`: `sec['net/dev']` → `sec['dev']` (la red de Docker salía siempre en 0). Las corridas Docker anteriores conservan los ceros: **no citar su red**; usar `v3fixnet-a1m1-f6-mezcla-lectura-r1` (arreglado, 40 req/s) y `v3basenet-a1m1-f6-mezcla-lectura-r1` (base, 10 y 40 req/s).
- Nuevo `resultados/_aws_costos_20261107/costos_consola.md`: costos leídos de la consola (bruto $7,84 del 1 al 7 de noviembre, créditos −$7,84, neto $0; el 6 de noviembre, día de v3, $5,87 bruto; 1-5 de noviembre son pruebas de carga anteriores).

- `BASE_RPS` usado: 10 req/s (ver `docs/PLAN.md`).
- Prueba de JVM (2026-11-07, tarde): F1-login en el PC nativo con Java 25 (`v3-f1-login-jvm25`) y Temurin 21.0.13 (`v3-f1-login-jvm21b`). El p50 sale 111,9 ms con las dos JVM, contra 59,8 ms en Docker: la JVM no explica que BCrypt cueste el doble en Windows nativo. `v3-f1-login-jvm21` corrió con Java 25 por error (ver su `NOTA.md`). En Windows, para cambiar de JVM hay que anteponer la ruta a `$env:Path` desde PowerShell; anteponerla al `PATH` de Git Bash no llega a `java`. Temurin 21 quedó en el scratchpad de la sesión, no en el proyecto. Precios oficiales en `resultados/_aws_precios_20261107/`. Borrador del informe en `informe/informe.md`.
- Créditos de la t3.small (2026-11-07): `telemetry/creditos.mjs` cruza CloudWatch (`ec2_t3small-unl/cloudwatch/`, que también cubre las corridas `unl-nplus1` porque usaron la misma instancia) con las ventanas de F6/F8. La pendiente de `CPUSurplusCreditBalance` es el cobro adicional. Arreglado: 0 hasta 40 req/s y 7,4 créditos/h a 80 req/s (4,48 USD/mes). Base: 31,4 créditos/h a 10 req/s (19,13 USD/mes). F8 lo confirma: 59,3 − 24 = 35,3 créditos/h, igual a la pendiente medida. Tabla en `resultados/_logs/creditos_ec2_unl_20261107.md`.

**Pendiente**
1. Informe (6-10 páginas) y sustentación de 7 min; cada afirmación con su número medido.
2. Tabla de costo mensual por opción (con 730 h/mes): EC2 t3.small ≈ $16,78 (con 20 GiB EBS a 0,08 USD/GiB-mes), Fargate 1 vCPU/1 GiB ≈ $32,80 (solo la app; ≈ $65,60 con una segunda tarea para `mongod`), m7a.xlarge ≈ $170,81 y m7a.2xlarge ≈ $340,32 (equivalentes alquilados del PC). PC: depreciación COP 4.000.000 ÷ vida útil (36 meses supuestos ≈ COP 111.000) + electricidad COP 18.000-33.000 (supuestos: 35-50 W, 700-900 COP/kWh) ≈ COP 129.000-144.000. **Los precios salen de sitios de terceros: verificar en las páginas de AWS y anotar la fecha; la tarifa eléctrica debe salir del recibo del usuario y la potencia del PC no está medida.**
3. Elegir la recomendación y responder las 4 preguntas (incluida la opción descartada).
4. Leer lo que no se ha leído: F2 (crecimiento con los datos), F3 (Amdahl), archivos de CloudWatch de EC2 (`cloudwatch/`) y la F8 de `std` (falló a λ = 23 con 100 % de errores): las explicaciones de caché, parte secuencial y créditos necesitan esos números.

**Cautelas**
- Ráfaga de disco en Windows (`v3fix-f7-trafico-x10`, ~12.400 IOPS de lectura de la máquina, procesos `mongod`/app con 0 MB/s de escritura): reportar la mediana (0), no el promedio de 701, y mencionarla como ruido.
- F6 del jar arreglado tiene 2 repeticiones, no 3.
- Facturación: revisar en la consola RDS ($0,14 sin explicar), Volúmenes y Elastic IPs por consumos de fondo de $0,2-0,7 diarios en días anteriores; hoy los cubren créditos.
- Reglas de `../CLAUDE.md`: no sobrescribir datos crudos y no copiar el secreto JWT de `application.properties`.

## 9. Dashboard (actualizado el 2026-11-07)

`dashboard/index.html` (comparación) y `dashboard/visor.html` (una corrida). Regenerar: `node dashboard/build.mjs` (`--no-cache` para rehacer todo). Abrir con doble clic (funciona con `file://`; `runs/*.js` se carga bajo demanda).
- **Visor** (`visor.js`, datos en `runs/<id>.js` generados por `rundetail.mjs`): cualquier corrida (F0-F8) con todas las series en una línea de tiempo: throughput, latencia p50/p95/p99, en vuelo, CPU máquina (us/sy/wa/steal), CPU por proceso con cuota, mapa de calor por hilo, RSS, heap y pausas de GC, IOPS, MB/s, utilización, E/S por proceso, red, frenado CFS, operaciones/documentos/caché de mongod y CloudWatch (EC2). Arrastrar para ampliar, elegir un paso para cifras exactas, “Comparar con” superpone otra corrida, tabla contra techos de F0, ficha de entorno/config/log y texto de “cifras para citar” con la carpeta de origen. Enlace profundo: `visor.html#run=<id>&b=<id>&step=<n>`.
- `index.html`: pestaña nueva “Entornos (hardware)”, enlaces al visor; `ui.js` es el código compartido.
- Las corridas `v3fixnet-*` y `v3basenet-*` (red de Docker) ahora son la fase `FX` y ya no contaminan las medianas de F6 (antes se clasificaban como F6 del jar base).
- Respaldos de la versión anterior: `app.js.bak-pre-visor`, `build.mjs.bak-pre-visor`, `app.css.bak-pre-visor`.

## 10. Pruebas pendientes (2026-11-09)

Cierran limitaciones de la sección 6 del informe. Nada sobrescribe corridas anteriores.

- Hecho: equivalencia del arreglo N+1 (`telemetry/comparar_respuestas.mjs`): 95 respuestas idénticas en la t3.small, `resultados/_equivalencia_20261109_ec2/`. RAM del PC: un módulo DDR5 de 16 GiB a 5.600 MT/s.
- En AWS (t3.small Unlimited i-0077b0b26e1e0cff0 y generador c7i-flex.large i-0c0cdd0fa3355982e, etiqueta `t3small-pend`): f9, que mide ver un lobby al azar con 20.000 lobbies en bloque, que caben en caché, contra 1.000.000 de ~3 KB, que no caben en RAM; y f7d, con datos de 2.000 y 20.000 lobbies y la predicción escrita antes en `resultados/_logs/prediccion_datos_ec2_20261109_104645.md`. Al terminar: `./campanas/recoger_ec2.sh 50.17.109.86 t3small-pend` y terminar las dos instancias.
- En el PC, cuando esté libre: `campanas/pendientes_local.sh` (unas 11 h 20 en total, partible con `SOLO`). Agrega el contador de frecuencia por hilo (`win-sampler.ps1`, `telemetry/frecuencia.mjs`), F1 de 360 s, F7 del contenedor con `-Xmx700m`, f7d, f9 en Docker, F6 de login y de `mezcla-postman`, y la tercera repetición de F6 con el jar corregido.
- Contadores de hardware: `setup/UPROF.md`.
- Cambios en las herramientas: `campana.sh` acepta `JAR`, `JAVA_OPTS`, `F1_OPS`, `F1_SEG`, `REP_FROM`, `NO_PROPIO` y las fases `f7d` y `f9`; `run.mjs` pasa `--java-opts` también en Docker y acepta `--bulk`; `lib/bulk.mjs` inserta lobbies directo en mongod.

## 11. Estado al 2026-11-09, noche (para retomar)

**AWS: hecho y apagado.** Las instancias i-0077b0b26e1e0cff0 (t3.small Unlimited) e i-0c0cdd0fa3355982e (c7i-flex.large) están `terminated` (comprobado con `aws ec2 describe-instances`). No queda nada encendido en AWS.

Datos traídos:
- `resultados/ec2_t3small-pend/`: `f9-caliente`, `f9-frio`, `f7d-datos-2000`, `f7d-datos-20000`, y en `_logs/` la predicción escrita antes (`prediccion_datos_ec2_20261109_170101.md`) y el estado de la campaña.
- `resultados/ec2_t3small-xmx/f7d-datos-20000/`: la repetición de 20.000 lobbies con `-Xmx1g`.

Resultados, ya escritos en `informe/informe.md` (sección 3 de la t3.small, respuestas de la sección 4 y limitaciones de la sección 6; commit `d44583f`, **sin push**):
- **F9, datos que no caben en memoria** (1.000.000 de lobbies, 3.117 MB contra 1,9 GiB): todos los niveles pasan hasta 400 req/s. A 400 req/s los fallos de caché suben de 0 % a 12-14 %, el disco llega a 365 IOPS (12 % de su capacidad) con `wa` 3,4 %, y el p95 sube de 28 a 121 ms. La CPU se llena antes que el disco.
- **F7d, 2.000 lobbies:** pasa. Predicción 9 % de CPU, medido 14 %.
- **F7d, 20.000 lobbies:** 100 % de errores aunque la predicción daba 37 % de CPU. Falla la memoria: heap por defecto de 478 MB, 95 pausas Full GC y `OutOfMemoryError` que mata el hilo `http-nio-8080-Poller` de Tomcat. Con `-Xmx1g` el kernel mata a Java a los 30 s (949 MB de Java más ~580 MB de `mongod` en 1,9 GiB). Conclusión del informe: la t3.small vale hasta pocos miles de lobbies; antes de 20.000 hay que paginar `GET /api/lobbies` (no medido).
- `campanas/campana.sh` ahora pasa `JAVA_OPTS` a la app del servidor EC2.

**Disco del PC.** Hoy C: llegó a 5 MB libres, sin causa encontrada (no fueron las corridas: lo bajado de AWS pesa 5,4 MB; el archivo de paginación tiene 20 GB asignados). Al cerrar la sesión había 11 GB libres. **Antes de lanzar pruebas en el PC, comprueba con `df -h /c` que haya al menos 5 GB** (p9 pide unos 2 GB). No se borró nada.

**Siguiente paso: pruebas del PC.** Desde Git Bash como administrador, con el PC sin otros programas:

```bash
cd lobbylink_perfv3 && SOLO="p3 p2 p4 p8" nohup ./campanas/pendientes_local.sh > resultados/_logs/_pendientes.txt 2>&1 &
```

Unas 2 h 10. Estado en `resultados/_logs/_pendientes_estado.txt`. Lo opcional (`SOLO="p9 p7 p5 p6"`, ~9 h 20) solo si sobra tiempo. Nota: p3 (equivalencia) ya está hecha en la t3.small; en el PC es una confirmación de 5 min.

**Después de las pruebas del PC:**
1. Leer cada corrida nueva y agregar sus números a los tres documentos de `informe/` (`informe.md`, `anexo_tecnico.md` capítulo 9.1 y `GUIA_INTERNA.md`, "Pruebas extra del 2026-11-09"; los tres ya tienen F9 y F7d de la t3.small): frecuencia por hilo (p2) en la explicación de BCrypt en Windows; F7 del contenedor con `-Xmx700m` (p4) donde el informe dice que el heap de 256 MB es un riesgo; f7d en PC y Docker (p8) junto a la de la t3.small, y quitar de la sección 6 la cautela de que F7d "por ahora solo en la t3.small".
2. Regenerar el dashboard: `node dashboard/build.mjs`.
3. Revisar el largo del informe (6-10 páginas) y preparar la sustentación de 7 min.
4. `git push` cuando el usuario lo pida.

## 12. Estado al 2026-11-10 (pruebas del PC hechas)

`SOLO="p3 p2 p4 p8"` terminó a las 01:44 con los cuatro pasos en código 0 (`resultados/_logs/_pendientes_estado.txt`). No se corrió lo opcional (p9 p7 p5 p6) ni AMD uProf.

- **p3:** 95 respuestas idénticas entre jars en el PC.
- **p2:** frecuencia por hilo, `20261110_045149_windows_v3frec-f1-login` (2.126 MHz ponderados en los hilos de la app) y `20261110_050048_windows_v3frec-f1-list` (2.768 MHz); tabla en `_logs/frecuencia_windows_f1_20261109.md`.
- **p4:** F7 del contenedor con `-Xmx700m`, `20261110_051149_docker_v3xmx-a1m1-f7-trafico-x10`: 10 req/s p95 459,4 ms; 100 req/s sigue con 100 % de errores y sin `OutOfMemoryError`. El heap no era la causa de la falla.
- **p8:** F7d en PC y contenedor. 2.000 lobbies pasan en los dos (p95 45,4 y 42,0 ms). 20.000: el PC pasa (p95 335,7 ms, RSS app 1.938 MB); el contenedor falla el 100 % por memoria (heap 247 MB, 1.782 Full GC, 178 `OutOfMemoryError`).
- Reposo del PC en F7d: 11,6 % y 12,3 % (límite 5 %); está anotado en el anexo.
- Documentos actualizados: `informe/informe.md`, `informe/anexo_tecnico.md` (cap. 9.1) y `informe/GUIA_INTERNA.md`. Dashboard regenerado. Sin `git commit` ni `push`.

Pendiente: revisar el largo del informe (6-10 páginas), preparar la sustentación y, si sobra tiempo, `SOLO="p9 p7"` y uProf (`setup/UPROF.md`). `git push` solo cuando el usuario lo pida.
