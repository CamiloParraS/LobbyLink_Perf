# Plan de medición v3: cargas derivadas de mediciones, no de supuestos

## Por qué existe v3

En v2 la carga se definía con un modelo de usuarios (sesión media 120 s, pausa 8 s, mezcla 75/15/10, 5 % de registros, 5 % de creaciones, 70 % que vuelve con token, y niveles de 60, 120, 160, 240, 600 y 1.200 usuarios). Ninguno de esos números salió de una medición. En la sustentación, a la pregunta "¿por qué ese número y no otro?" la única respuesta posible era "lo elegimos".

v3 invierte el orden: **lo único que entra es lo que la app cuesta, medido**. A partir de ese costo se predice el techo de cada máquina, se arman los niveles de carga y luego se comprueba la predicción con carga sostenida.

## Tres clases de números (y solo tres)

| Clase | Ejemplos | Cómo se defiende |
|---|---|---|
| **Medido** | ms de CPU por petición (D), p50/p95/p99, RSS, IOPS, MB/s, red, req/s logradas, IOPS de `fio`, Mbit/s de `iperf3` | "Lo medimos; este es el archivo crudo y el guion" |
| **Derivado del código o de la configuración** | `GET /api/lobbies` sin paginación y con N+1 doble (`toSummaryDto`: `findById` + `countByLobbyId` por lobby); JWT de 24 h; BCrypt en login y registro; la mezcla `mezcla-postman` (el recorrido de la colección Postman del proyecto) | "Está en el código o en el proyecto: archivo y línea" |
| **Declarado** (dos) | Requisito de latencia: p95 ≤ 1.000 ms y errores ≤ 1 % (`profiles/umbrales.json`) | "Es un requisito, no una medición. Mostramos que la recomendación no cambia con 300, 500 o 1.000 ms" (columnas `passAt`) |
| | Tamaño de datos de referencia: 200 lobbies (1 videojuego, 20 usuarios, un participante por lobby). Heredado de v1 y v2 | "Es un tamaño de referencia para que las corridas sean comparables entre máquinas y con v2, no una estimación de uso. Medimos el listado de 100 a 1.600 lobbies (F2) y 2.000 (F7): la recomendación es la misma en todos" (`telemetry/sensibilidad.mjs`, `resultados/_logs/sensibilidad_lobbies_20261107.md`) |

Todo lo demás (niveles de carga, rampa, ×10) se calcula a partir de la primera clase.

## Decisiones de diseño

1. **Carga a tasa fija (modelo abierto), en req/s.** `rate.mjs` manda λ peticiones por segundo como proceso de Poisson, con semilla, respondan o no. La única entrada es λ, en la misma unidad que se mide, así que no hay duración de sesión, pausa ni usuarios que justificar. Si hace falta hablar de usuarios, se convierte después con la ley de Little (activos = llegadas/s × duración), dicho como conversión.
2. **Latencia desde la hora programada.** Si el servidor se atasca, la espera de las peticiones que debían salir cuenta (en bucle cerrado esa espera desaparece: omisión coordinada). Los timeouts cuentan como error con latencia = timeout. Si el propio generador se atrasa más de 50 ms (p99), el nivel se marca como inválido (`genOk`).
3. **Bucle cerrado solo donde corresponde.** Con 1 worker para medir D (sin cola, la CPU por petición es el costo puro) y con 1..2×hilos workers para Amdahl (es el laboratorio de la sesión 05).
4. **La mezcla es un parámetro, no un supuesto.** Se mide cada endpoint aislado y la capacidad de cualquier mezcla sale de la ley de utilización: X_max = capacidad / Σ pᵢ·Dᵢ. Dos mezclas tomadas del proyecto (`mezcla-lectura`, `mezcla-postman`) sirven para validar el modelo y para comparar entornos.
5. **La comparación usa la misma escala absoluta en las tres máquinas** (5, 10, 20, 40, 80 req/s). Es una malla de duplicación, no una estimación de tráfico: cubre desde muy por debajo del codo más bajo medido en v2 (≈ 28 req/s en EC2 y en el contenedor) hasta por encima del más alto (≈ 75 en el PC). Si la F5 de v3 da codos fuera de ese rango, se ajusta `ESCALA` y se documenta.
6. **Generador en otra máquina siempre que se pueda.** En el PC el generador comparte la CPU con `mongod` (la máquina llegó al 98 % en v2). Lo correcto es generar desde otro equipo de la red local; si no se puede, se deja la afinidad (app en hilos 0-7, generador en 8-11) y se dice en el informe.

## Fases (las mismas en las tres opciones)

| Fase | Qué se corre | Valores y por qué | Duración aprox. |
|---|---|---|---|
| **F0** sondas | `setup/sondas.sh`: `fio` (lectura aleatoria 4 KiB QD32, escritura 4 KiB con `fsync`, lectura secuencial 1 MiB) e `iperf3` (EC2) | Techo del hardware para comparar con lo que la app usa. Escritura con `fsync` = lo que hace el journal de WiredTiger al confirmar. Laboratorio de la sesión 07 | 4 min |
| **F1** costo por endpoint | `load.mjs`, 1 worker, 120 s medidos + 20 s de calentamiento, un endpoint por corrida: `list`, `view`, `login`, `register`, `create`, `join` | 1 worker = sin cola. D = (CPU en la ventana − CPU en reposo) / req/s, separado en app y `mongod`. 120 s a 1 worker dan ≥ 60 muestras del agente | 6 × 4 min |
| **F2** datos | Listado con 100, 200, 400, 800 y 1.600 lobbies, 1 worker, 90 s | Duplicaciones: la pendiente log-log da el exponente del costo (1 = lineal, 2 = cuadrático). El código predice ≈ 2 (un conteo sin índice que recorre `participaciones` por cada lobby) | 5 × 3 min |
| **F3** Amdahl | Bucle cerrado `solo-list` y `login` con 1, 2, 4, 8, 16 workers (PC: 8 hilos fijados = 4 núcleos con SMT) o 1, 2, 4 (t3.small: 1 núcleo, 2 hilos), 60 s por nivel | Hasta el doble de los hilos, como pide la sesión 05. `amdahl.mjs` despeja p de S(N) = 1/((1−p) + p/N) y mide la ganancia de SMT. Login (BCrypt, CPU pura en Java) contra listar (`mongod`) | 2 × 8 min |
| **F4** cuotas (solo contenedor) | App × `mongod` = 1×0,5, 1×1, 1×2, 1×4, 2×1, 4×1 CPU, bucle cerrado 1/4/16 | Muestra qué proceso limita: si dar más CPU a la app no mueve el techo y dárselo a `mongod` sí, el cuello es `mongod` (Amdahl). `throttled` ms/s mide el frenado de la cuota CFS | 6 × 5 min |
| **F5** rampa | `rate.mjs`, λ = 10 %, 20 % … 150 % del X_max **predicho por F1**, 90 s por nivel, corta tras 2 niveles que no pasan; con `mezcla-lectura` y `mezcla-postman` | La rampa se construye desde la predicción, no desde un número elegido. Codo medido contra predicho = validación del modelo (`model.mjs --validate`) | 2 × ≤ 30 min |
| **F6** sostenida | `rate.mjs`, `mezcla-lectura`, λ = 5, 10, 20, 40, 80 req/s, **600 s por nivel**, 3 repeticiones con semillas 1-3; corta en el primer nivel que no pasa. Además, cada máquina al 50 % y al 80 % de su propio codo | Carga sostenida de minutos (enunciado), repetida y en percentiles (sesión 10); se reporta la mediana de las 3 repeticiones; si el p95 difiere más de 20 % entre repeticiones, se dice | ≈ 45 min × 3 + 25 min |
| **F7** ×10 | Primero se escribe la predicción (`model.mjs --base-rps`, archivo con marca de tiempo). Luego: λ = BASE y 10 × BASE (tráfico ×10) y BASE con 2.000 lobbies (datos ×10), 600 s | BASE_RPS = el nivel de F6 que la opción recomendada sostiene holgada (el mayor λ de la escala que pasa con utilización ≤ 50 %). Se elige al ver F6 y se anota | 35 min |
| **F8** larga (EC2) | BASE_RPS durante 40 min en la t3.small | Créditos de CPU: la t3 rinde completo mientras tiene créditos. Se mira `CPUCreditBalance` en CloudWatch antes y después, y Standard contra Unlimited | 42 min |

Tiempo total por entorno con `REPS=3`: unas 4 h 30 min para F0-F6 y 1 h 20 min para F7-F8. Para humo: `QUICK=1` (fases de 20-60 s; no va al informe).

## Cómo cada fase responde las preguntas de la sustentación

| Pregunta | Número medido que la responde | Fase |
|---|---|---|
| ¿Por qué ese número y no otro? ¿Cómo lo midieron? | "El listado cuesta X ms de CPU de `mongod` por petición; con C CPU el techo es C/X req/s; lo predijimos así y la rampa lo midió en Y". Toda λ usada sale de esa cadena o de la escala fija, con semilla y guion | F1 → F5, F6 |
| ¿Qué componente causa ese comportamiento? | `us` alto y `wa` ≈ 0 con el disco a una fracción de lo que mide `fio` → CPU, no disco. % del costo en `mongod`. Exponente de F2 (N+1). p de Amdahl y ganancia de SMT (núcleos que comparten ALU y caché L1/L2). Cuotas de F4 (cuota CFS y frenado) | F0, F1, F2, F3, F4 |
| Si la carga se multiplicara por diez, ¿qué se rompería primero? | Predicción escrita antes de medir (utilización de cada recurso a 10 × BASE) y medición de tráfico ×10 y datos ×10 | F7 |
| ¿Qué opción descartaron y por qué? | Tabla F6 (pasa o no en cada λ, qué sobra y qué falta), créditos en F8, y **costo por cada 1.000 peticiones** dentro del requisito: precio/h ÷ (req/s sostenidas × 3,6) | F6, F8 |

## Regla de recomendación (margen)

Sin tráfico real no hay una "carga objetivo" medida. La regla se expresa sobre lo medido: una opción **sirve** para una carga λ si, a esa λ, cumple el requisito (F6) y su recurso más usado está a ≤ 60 % de la capacidad medida en F5. El 40 % restante es margen para picos y para el crecimiento de datos que mide F2. Se recomienda la opción más barata por cada 1.000 peticiones entre las que sirven, y la tabla muestra hasta qué λ sirve cada una. BASE_RPS (F7) = el mayor λ de la escala en que la opción recomendada cumple esta regla.

## t3 en Unlimited y en Standard

La t3.small se mide dos veces (ver `setup/EC2.md`): en **Unlimited** (no se frena, se pagan los créditos excedentes) y en **Standard** (sin créditos se frena a la línea base de la ficha, 20 % por vCPU). En Standard, el modelo usa `--pool 0.4` (2 vCPU × 20 %) para predecir el techo, F5 lo comprueba y `steal` muestra el freno en cada muestra. F8 en Standard mide cuánto dura una ráfaga con el saldo acumulado en 60 min de reposo, contra la predicción de ≈ 15 min (24 créditos ÷ 1,6 créditos netos/min). Así, "¿qué opción descartaron?" tiene un número medido detrás.

## Costo normalizado (lo pide la sesión 10)

- Nube: precio por hora × 730 + EBS (+ créditos excedentes si es Unlimited, con el precio de la página oficial y la fecha de consulta).
- Contenedor: fracción de la máquina anfitriona según la cuota (p. ej. 2 CPU de 12 hilos), sobre el costo de esa máquina.
- PC físico: depreciación mensual + energía medida (vatímetro o, si no hay, el TDP declarado y dicho como tal).
- Costo por 1.000 peticiones = costo por hora / (req/s sostenidas dentro del requisito × 3.600 / 1.000).

## Qué falta decidir con datos (no antes)

- `BASE_RPS` (F7, F8): después de F6. **Valor usado: 10 req/s** (F7 en PC, Docker y EC2; F8 de EC2 con λ = 10 en `unl` y `unl-nplus1`, y λ = 23 en `std`). Elegido por el usuario; no se verificó aquí contra la regla de utilización ≤ 50 % de F6.
- `ESCALA`: se mantiene 5-80 salvo que F5 muestre codos fuera de ese rango.
- Si algún entorno no alcanza 5 req/s dentro del requisito, se agregan niveles 1 y 2 y se documenta.

## Salvedades que ya se conocen

- MongoDB 9.0.4 en el PC y `mongo:7` en el contenedor y en EC2: versiones distintas.
- En el PC, `mongod` solo queda fijado si `run.mjs` corre como administrador (`run.json` → `pinned`).
- Docker Desktop corre sobre una VM WSL2: el contenedor mide "VM + cuota", no Linux nativo.
- Los datos de LobbyLink caben de sobra en la caché de WiredTiger (cientos de KB a pocos MB contra 256 MB o más): el disco solo aparece en escrituras (journal). No se fuerza un escenario "sin caché" porque, con el N+1 cuadrático, la colección necesaria haría que un solo listado tardara minutos. Esto es un resultado, y se explica con los fallos de caché ≈ 0 % que mide el agente.
