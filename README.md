# lobbylink_perfv3

Tercera versión del laboratorio de mediciones de LobbyLink (proyecto final de Arquitectura Computacional). Sustituye el modelo de sesiones de v2, cuyos parámetros eran supuestos, por **cargas derivadas de mediciones**. El plan y la justificación de cada valor están en [`docs/PLAN.md`](docs/PLAN.md). Léelo primero.

Los datos de v1 y v2 quedan en `../lobbylink_perf/resultados/` y `../lobbylink_perfv2/resultados/`. **No son comparables con v3**: el informe se arma solo con las corridas `v3-*`.

## Piezas

| Archivo | Para qué |
|---|---|
| `telemetry/rate.mjs` | **Generador principal.** Tasa fija (Poisson, con semilla), latencia desde la hora programada, timeouts contados, control de validez del generador |
| `telemetry/load.mjs` | Bucle cerrado. Solo para F1 (1 worker = costo puro) y F3 (Amdahl) |
| `telemetry/lib/lobbylink.mjs` | Cliente, siembra y endpoints compartidos (`join` recorre pares usuario-lobby sin repetir) |
| `telemetry/model.mjs` | Modelo de costo: D por endpoint, X_max por mezcla, predicción ×10, barrido de datos, validación |
| `telemetry/amdahl.mjs` | Fracción paralela p y ganancia de SMT a partir de F3 |
| `telemetry/knee.mjs` | Codo medido de una rampa (mayor λ que pasa) |
| `telemetry/report.mjs` | Tablas por corrida (rendimiento, recursos, `mongod`, GC, tasa fija) |
| `telemetry/agent.mjs`, `win-sampler.ps1`, `lib/mongostat.mjs` | Telemetría (igual que v2) |
| `setup/sondas.sh` | F0: `fio` e `iperf3` |
| `campanas/campana.sh` | Campaña F0-F8 en `windows`, `docker` o `ec2` |
| `campanas/recoger_ec2.sh` | Trae la campaña de AWS al PC |
| `telemetry/profiles/` | `solo-*` y `login` (F1), `mezcla-lectura` y `mezcla-postman` (del recorrido de la colección Postman), `umbrales.json` (el único valor declarado) |

## Cómo se corre

```bash
# Requisitos en el PC: MongoDB en :27017, el jar compilado (../LobbyLink_backend: mvnw.cmd clean package), Docker Desktop,
# fio para Windows (F0). Terminal de ADMINISTRADOR para que mongod quede fijado (si no, run.json -> pinned dice FALLO).

# humo (fases cortas, no va al informe)
QUICK=1 REPS=1 FASES="f1 f5" ./campanas/campana.sh windows

# campaña real (salida a archivo, en segundo plano)
nohup ./campanas/campana.sh windows,docker > resultados/_logs/_campana.txt 2>&1 &
cat resultados/_logs/_campana_estado.txt                 # en qué va

# después de F6, con BASE_RPS elegido según docs/PLAN.md
BASE_RPS=10 FASES="f7" ./campanas/campana.sh windows,docker

# AWS: en el generador, dentro de tmux (preparación igual que v2: setup/ec2-preparar.sh)
./campanas/campana.sh ec2 <IP_PRIVADA_SERVIDOR> t3small
BASE_RPS=10 FASES="f7 f8" ./campanas/campana.sh ec2 <IP_PRIVADA_SERVIDOR> t3small
# en el PC
./campanas/recoger_ec2.sh <IP_PUBLICA_GENERADOR> t3small
```

Corridas sueltas:

```bash
node telemetry/run.mjs --env windows --label prueba --profile solo-view --workers 1 --seconds 120
node telemetry/run.mjs --env docker --app-cpus 1 --mongo-cpus 2 --label prueba --profile mezcla-lectura --rates 5,10,20 --seconds 600
```

## Tablas para el informe

```bash
node telemetry/model.mjs resultados/*_windows_v3-f1-*                                  # D y X_max
node telemetry/model.mjs --sweep resultados/*_windows_v3-f2-*                          # exponente del N+1
node telemetry/amdahl.mjs --cores 4 --threads 8 resultados/*_windows_v3-f3-*
node telemetry/model.mjs resultados/*_windows_v3-f1-* --validate resultados/*_windows_v3-f5-mezcla-lectura
node telemetry/report.mjs resultados/*_windows_v3-f6-* > resultados/RESULTADOS_pc.md
```

La campaña ya deja estas tablas en `resultados/_logs/` (`modelo_*`, `datos_*`, `amdahl_*`, `validacion_*`, `prediccion_x10_*`).

## Reglas (las de siempre)

- No sobrescribir datos crudos: cada corrida tiene su carpeta con marca de tiempo y una base de Mongo nueva.
- No correr dos corridas a la vez en el PC. Cerrar programas pesados antes de medir: el reposo se controla (`idle.json`) y `STRICT=1` cancela si está sucio.
- No imprimir ni copiar `jwt.secret`.
- Lanzar campañas con la salida a archivo y en segundo plano, nunca con tubería.
- Anotar el entorno de cada medición nueva con el detalle de `../CLAUDE.md`.

## Costos de AWS

- Lo leído en la consola de AWS (Cost Explorer, por tipo de cargo): `resultados/_aws_costos_20261107/costos_consola.md`.
- Estimación por horas × precio de la ficha, con los volcados de la API: `resultados/_aws_costos_20261106/`.
- Estado del proyecto y pendientes: `HANDOFF.md`, sección 8.
