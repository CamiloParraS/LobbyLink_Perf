# Guía interna: glosario y mediciones explicadas en simple

Documento de estudio para el equipo. No se entrega. Sirve para preparar la sustentación y para entender el informe (`informe.md`) sin tener que leer el código. Cada cifra tiene al lado la carpeta de `resultados/` de donde sale, por si hay que mostrarla.

## Parte 1. La idea en cinco frases

1. Queríamos saber en qué máquina debe correr LobbyLink, y la respuesta tenía que salir de mediciones nuestras.
2. Primero medimos cuánto le cuesta a la máquina una sola petición de cada tipo. Con eso calculamos cuántas peticiones por segundo debería aguantar cada máquina.
3. Después le mandamos carga real durante varios minutos para comprobar ese cálculo y ver dónde se rompe.
4. Encontramos que la aplicación se queda sin CPU, sobre todo la de MongoDB, porque el listado de lobbies hace cientos de consultas por petición (el problema N+1).
5. Con el N+1 corregido, la máquina más barata (t3.small) aguanta 8 veces más carga que antes y cuesta menos al mes. Esa es la recomendación.

## Parte 2. Glosario

Ordenado por tema. Si en la sustentación aparece una palabra, búsquenla aquí.

### Carga y latencia

**Petición (request).** Una llamada HTTP a la API, por ejemplo `GET /api/lobbies`.

**req/s (peticiones por segundo).** Cuántas peticiones llegan o se responden cada segundo. Es la unidad de carga de todo el trabajo.

**λ (lambda).** La tasa de llegada que le mandamos al servidor, en req/s. "λ = 10" significa que el generador manda 10 peticiones por segundo, respondan o no.

**Throughput o X.** Las peticiones por segundo que el servidor de verdad responde. Si el servidor aguanta, X = λ. Si no aguanta, X se queda por debajo de λ y las peticiones se acumulan.

**Latencia.** Lo que tarda una petición desde que debía salir hasta que llega la respuesta, en milisegundos (ms).

**Percentil (p50, p95, p99).** Se ordenan todas las latencias de menor a mayor. El p50 es la del medio: la mitad de las peticiones tardó menos que eso. El p95 deja por debajo al 95 %, así que solo el 5 % tardó más. El p99 deja por debajo al 99 %. El promedio esconde a los usuarios que esperan mucho, y el p95 y el p99 los muestran.

**Requisito.** Lo que decidimos que significa "funciona bien": p95 ≤ 1.000 ms y errores ≤ 1 %. Es uno de los dos números que elegimos nosotros (el otro es el tamaño de referencia de 200 lobbies). Está en `telemetry/profiles/umbrales.json`.

**Tamaño de referencia (200 lobbies).** La cantidad de datos con la que se siembra cada corrida. No es una estimación de uso real: es el tamaño que traíamos de las versiones anteriores, para que todas las corridas sean comparables. Como el costo del listado depende de este número, lo medimos también con 100 a 2.000 lobbies (análisis de sensibilidad).

**Análisis de sensibilidad.** Repetir la conclusión cambiando un número elegido, para ver si depende de él. Lo hicimos con el requisito (300, 500 y 1.000 ms) y con el tamaño de datos (100 a 2.000 lobbies).

**Pasa / no pasa.** Un nivel de carga "pasa" si cumple el requisito.

**passAt (sensibilidad).** El reporte también dice si cada nivel pasaría con un requisito más estricto (p95 ≤ 300 ms o ≤ 500 ms). Muestra que la recomendación no depende de haber elegido 1.000 ms. Con el jar base sí cambia el máximo de cada opción, porque el último nivel que pasa tiene p95 entre 390 y 830 ms.

**Timeout.** Si una petición no responde en 10 s, el generador la corta y la cuenta como error con latencia de 10 s. Por eso cuando algo colapsa vemos siempre p95 = 10.181 ms: es el tope del timeout más el error del histograma, no una latencia real.

**Codo.** El punto donde la latencia deja de subir despacio y se dispara. Pasa cuando el recurso más ocupado se acerca al 100 % y las peticiones empiezan a hacer fila.

### Cómo se genera la carga

**Generador.** Nuestro programa que manda las peticiones y mide la latencia (`telemetry/rate.mjs` y `telemetry/load.mjs`).

**Bucle cerrado (closed loop).** Hay N "workers". Cada uno manda una petición, espera la respuesta y manda la siguiente. Si el servidor se pone lento, los workers mandan menos. Lo usamos solo para F1 (1 worker, para medir el costo puro) y para F3 y F4.

**Worker.** Un cliente que hace peticiones una tras otra en el bucle cerrado.

**Tasa fija (modelo abierto).** El generador manda λ peticiones por segundo sin esperar respuesta, como llegan usuarios reales que no saben si el servidor está lento. Lo usamos en F5, F6, F7 y F8.

**Proceso de Poisson.** La forma de repartir las llegadas en el tiempo: al azar, pero con promedio λ. A veces llegan dos juntas y a veces hay un hueco, como en la realidad.

**Semilla.** El número que fija la secuencia "al azar". Con la misma semilla, el generador manda exactamente la misma secuencia de peticiones, así que una corrida se puede repetir.

**Omisión coordinada.** Es un error de medición común. En bucle cerrado, si el servidor se atasca 2 s, el worker no manda nada durante esos 2 s y esa espera nunca se cuenta. Nosotros medimos la latencia desde la hora en que la petición debía salir, así que ese atasco sí aparece.

**genLag / genOk.** Cuánto se atrasa el propio generador. Si se atrasa más de 50 ms en p99, el nivel no vale (`genOk = false`), porque estaríamos midiendo al generador y no al servidor.

**Mezcla (perfil).** Qué proporción de cada tipo de petición se manda. `mezcla-lectura` es 50 % listar y 50 % ver un lobby, y es la que usamos para comparar máquinas. `mezcla-postman` repite el recorrido de la colección Postman del proyecto.

**Ley de Little.** Usuarios activos = llegadas por segundo × tiempo que dura cada uno. La usamos solo para traducir req/s a "usuarios" si alguien lo pregunta, no para definir la carga.

### Modelo de capacidad

**D (demanda de servicio).** Cuántos milisegundos de CPU gasta una sola petición, separados en la app (Java) y `mongod`. Se mide con 1 worker para que no haya fila: D = (CPU usada − CPU en reposo) / req/s.

**Utilización.** Qué fracción del recurso está ocupada. Ley de utilización: utilización = λ × D. Si D = 100 ms y llegan 5 req/s, se ocupan 500 ms de CPU cada segundo, es decir medio núcleo.

**X_max (techo predicho).** El máximo de req/s antes de llegar al 100 %: X_max = CPU disponible / D. Es un techo optimista, porque supone que D no cambia con la carga.

**Reposo (idle).** La CPU que usa la máquina sin carga. Se resta para que D sea solo el costo de las peticiones. Si el reposo está "sucio" (otros programas abiertos), D sale con ruido.

### Procesador

**Núcleo (core).** Una unidad completa de procesamiento, con sus propias unidades de cálculo (ALU) y sus cachés L1 y L2.

**Hilo (thread) y SMT / Hyper-Threading.** Un núcleo puede atender dos hilos a la vez. Cuando uno espera, por ejemplo un dato de memoria, el otro usa las unidades libres. SMT es el nombre general y Hyper-Threading el de Intel. Dos hilos no valen dos núcleos, porque comparten las mismas unidades y cachés.

**vCPU.** La CPU que ve una máquina virtual. En la t3.small cada vCPU es un hilo, así que sus 2 vCPU son 1 núcleo físico con sus 2 hilos (documentación de AWS). En la c7a cada vCPU es un núcleo completo.

**Afinidad.** Decirle al sistema operativo en qué hilos puede correr un proceso. En el PC pusimos la app y `mongod` en los hilos 0-7 y el generador en los hilos 8-11, para que no se peleen la CPU.

**us, sy, wa, steal.** Cómo reparte Linux el tiempo de CPU:
- `us` (user): trabajo de los programas.
- `sy` (system): trabajo del kernel.
- `wa` (iowait): tiempo esperando al disco.
- `steal`: tiempo que el hipervisor no le dio a la máquina virtual.

Si `us` es alto y `wa` es 0, la aplicación espera por CPU y no por disco.

**Ley de Amdahl.** Si una parte del trabajo no se puede repartir (la parte secuencial), agregar núcleos tiene un límite. Con p = fracción paralela, la aceleración máxima es 1 / (1 − p). Si p = 0,95, ni con infinitos núcleos se pasa de 20 veces.

**Aceleración S(N).** Cuántas veces más rinde con N workers que con 1: S(N) = X(N) / X(1).

**Turbo.** Frecuencia máxima que un núcleo alcanza cuando hay margen de energía y temperatura. La de ficha (Ryzen 4,7 GHz, Xeon 3,1 GHz) es un tope, no lo que se sostiene siempre. En el Xeon medimos 3,07 GHz con un hilo.

**Latencia de memoria.** Cuánto tarda un acceso a cada nivel: L1 1,62 ns, L2 4,54 ns, L3 ~25-30 ns, RAM ~100-118 ns en la t3.small. Se mide con un recorrido aleatorio de memoria que no se puede adelantar.

**Microbenchmark.** Un programa pequeño que mide una sola cosa del hardware (frecuencia, latencia de caché), separada de la aplicación.

**Frecuencia / IPC.** La frecuencia es cuántos ciclos por segundo da el núcleo (GHz). El IPC es cuántas instrucciones hace por ciclo. El rendimiento por hilo depende de las dos, y por eso un Zen 4 a 4,7 GHz hace un BCrypt más rápido que un Xeon a 2,5-3,1 GHz.

### Memoria y disco

**Caché (del procesador).** Memoria muy rápida y pequeña dentro del procesador (L1, L2, L3). Si el dato está ahí, leerlo cuesta nanosegundos. Si no, hay que ir a la RAM, que es mucho más lenta.

**Caché de WiredTiger.** La memoria donde MongoDB guarda los datos que usa. Si el dato está ahí, no toca el disco. Su tamaño es 50 % de (RAM − 1 GB), con un mínimo de 256 MB.

**Fallo de caché (cache miss).** Pedir algo que no está en la caché y tener que ir al nivel más lento. Medimos 0 % de fallos en la caché de WiredTiger: los datos caben enteros (unos 10 MB). En F9, con 1.000.000 de lobbies que no caben, subieron a 12-14 %.

**RSS (memoria residente).** La RAM que un proceso está usando de verdad, no la que pidió. Es la métrica de memoria que pide el enunciado.

**Heap y GC.** El heap es la memoria donde Java guarda los objetos. El GC (recolector de basura) la limpia y a veces hace pausas cortas.

**Full GC y `OutOfMemoryError`.** Un Full GC es una recolección de todo el heap que detiene la app entera. Si después de limpiar sigue sin haber espacio, Java lanza `OutOfMemoryError` y el hilo que pedía memoria muere. Con 20.000 lobbies pasó las dos cosas (95 Full GC y 4 errores).

**`-Xmx`.** La opción de Java que fija el tamaño máximo del heap. Sin ella, la JVM toma un cuarto de la memoria que ve: 256 MB en el contenedor de 1 GB y 478 MB en la t3.small.

**OOM killer.** La parte del kernel de Linux que mata un proceso cuando la máquina se queda sin RAM. Mató a Java en la t3.small cuando le dimos `-Xmx1g` con 20.000 lobbies.

**Paginación.** Devolver una lista por páginas (por ejemplo de 50 en 50) en lugar de toda de una vez. `GET /api/lobbies` no la tiene, y por eso con 20.000 lobbies no cabe en memoria.

**IOPS.** Operaciones de entrada y salida por segundo contra el disco. Importa para lecturas o escrituras pequeñas y al azar.

**MB/s.** Megabytes por segundo leídos o escritos. Importa para lecturas grandes y seguidas.

**Profundidad de cola (QD).** Cuántas operaciones de disco se mandan sin esperar a que termine la anterior. Con QD32 el disco puede atender muchas a la vez, y con QD1 se mide la latencia de una sola.

**fsync.** La orden de "escribe esto al disco ya y confirma". Es lenta porque no puede quedarse en memoria. MongoDB la usa en el journal.

**Journal.** El registro donde MongoDB anota cada escritura antes de confirmarla, para no perderla si se apaga la máquina.

**E/S directa (`--direct=1`).** Leer y escribir sin pasar por la caché del sistema operativo, para medir el disco real.

**EBS gp3.** El disco de la t3.small. No está dentro de la máquina: es un volumen al que se llega por la red del centro de datos. Trae 3.000 IOPS y 125 MB/s incluidos.

### Contenedores y virtualización

**Contenedor.** Un proceso aislado que comparte el kernel del sistema. No es una máquina virtual completa.

**cgroups.** El mecanismo de Linux que pone límites de CPU y memoria a un grupo de procesos, como un contenedor.

**Cuota CFS (`cpus: 1`).** El límite de CPU del contenedor: 100 ms de CPU por cada periodo de 100 ms. CFS es el planificador de Linux.

**Frenado (throttling).** Si el contenedor gasta su cuota antes de que termine el periodo, el kernel lo detiene hasta el siguiente. Lo medimos en ms frenados por segundo.

**Hipervisor.** El programa que reparte una máquina física entre varias máquinas virtuales. Hyper-V en el PC y Nitro en AWS.

**WSL2.** La máquina virtual de Linux que usa Windows. Docker Desktop corre sus contenedores dentro de ella. Por eso el contenedor mide "VM más cuota" y no Linux directo.

### AWS

**Instancia.** Una máquina virtual de AWS. El tipo (t3.small, c7a.2xlarge) dice cuánta CPU y RAM tiene.

**Créditos de CPU.** La t3 es una instancia "con ráfagas". Gana 24 créditos por hora y gasta 1 crédito por cada minuto que una vCPU trabaja al 100 %. Ganar 24 por hora equivale a usar 20 % de cada vCPU todo el tiempo (la línea base).

**Unlimited.** Modo en que la t3 puede pasar de la línea base todo lo que quiera, y AWS cobra lo que gaste de más a 0,05 USD por vCPU-hora.

**Standard.** Modo en que, si se acaban los créditos, el hipervisor limita la t3 a la línea base (0,4 vCPU en total). La CPU quitada aparece como `steal`.

**Saldo excedente (surplus).** En Unlimited, los créditos gastados por encima de lo ganado. Es lo que se cobra.

**CloudWatch.** El servicio de métricas de AWS. De ahí sacamos los créditos (`CPUCreditUsage`, `CPUCreditBalance`, `CPUSurplusCreditBalance`).

### La aplicación

**API REST.** Una aplicación que se usa con peticiones HTTP (GET, POST) y responde en JSON.

**Spring Boot.** El framework de Java en el que está hecho LobbyLink.

**MongoDB / `mongod`.** La base de datos. `mongod` es el proceso del servidor de MongoDB.

**JWT.** El "pase" que entrega el login. La app lo verifica sin consultar la base, así que no guarda sesiones.

**BCrypt.** El algoritmo que convierte la contraseña en un hash. Es lento a propósito (factor 10, 2¹⁰ rondas) para frenar ataques. Por eso login y registro gastan unos 56-112 ms de CPU de la app.

**Problema N+1.** Hacer 1 consulta para traer N cosas y después 1 consulta más por cada una. En LobbyLink, listar 200 lobbies hace 1 + 200 conteos + 200 búsquedas de videojuego, unas 400 consultas.

**Índice.** Una estructura que le permite a la base encontrar documentos sin recorrerlos todos. `participaciones.lobbyId` no tiene índice, así que cada conteo recorre la colección.

**Agregación.** Una consulta de MongoDB que agrupa y cuenta muchos documentos de una vez. El arreglo la usa para contar los participantes de todos los lobbies en una sola consulta.

**Jar base / jar arreglado.** El jar base es el código original. El arreglado (`disenofinal-nplus1-fix.jar`) corrige el N+1. En las carpetas, `v3-*` es el base y `v3fix-*` o `*-nplus1` es el arreglado.

### Herramientas nuestras

**Agente (`agent.mjs`).** Programa que mide la máquina cada 1-2 segundos mientras corre la carga: CPU total y por proceso, RSS, disco, red, frenado y estadísticas internas de MongoDB.

**`fio`.** Herramienta estándar para medir discos (IOPS, MB/s, latencia).

**`iperf3`.** Herramienta estándar para medir la red entre dos máquinas.

**Corrida.** Una ejecución completa: base de datos nueva, app nueva, reposo, carga y recolección. Cada una tiene su carpeta en `resultados/`.

## Parte 3. Cada fase explicada

Cada fase responde una pregunta. Para cada una: qué preguntamos, cómo lo medimos, qué salió y qué significa.

### F0. ¿Cuánto puede dar el hardware?

**Cómo.** Antes de tocar la aplicación corrimos `fio` sobre el disco (lectura al azar, escritura con `fsync`, lectura seguida) e `iperf3` sobre la red. Es como medir el ancho de una tubería antes de ver cuánta agua pasa.

**Qué salió.**

| | PC | Contenedor | t3.small |
|---|---|---|---|
| Lectura al azar (IOPS) | 41.903 | 79.766 | 3.049 |
| Escritura con `fsync` (IOPS) | 1.488 | 1.155 | 354 |
| Lectura seguida (MB/s) | 1.306,8 | 1.410,6 | 127,3 |

**Qué significa.** El disco de la t3.small topa justo en lo que AWS incluye con gp3 (3.000 IOPS y 125 MB/s). El límite lo pone el volumen, no el SSD. Ese disco es unas 14 veces más lento que el NVMe del PC en lectura al azar. Aun así no importa para LobbyLink, porque la aplicación casi no toca el disco (ver capítulo 5 del informe).

**Ojo.** El contenedor lee más rápido que el PC sobre el mismo disco. Lo más probable es que Windows esté sirviendo parte de esas lecturas desde su caché en RAM. No es una mejora real.

### F1. ¿Cuánto cuesta una petición?

**Cómo.** Un solo worker manda un tipo de petición durante 120 s. Con un solo cliente nunca hay fila, así que todo el tiempo es trabajo puro. Medimos la CPU de la app y de `mongod`, restamos el reposo y dividimos por las req/s. Se hace con cada uno de los seis endpoints.

**Qué salió** (ms de CPU por petición, jar base, carpetas `_logs/modelo_*_f1.md`):

| | PC | Contenedor | t3.small |
|---|---|---|---|
| Listar 200 lobbies (app + `mongod`) | 55 + 165 | 72 + 98 | 63 + 104 |
| Login (app) | 112,9 | 56,8 | 83,6 |
| Ver un lobby (total) | 5 | 5 | 4 |

**Qué significa.** Listar cuesta entre 33 y 43 veces más que ver un lobby, y la mayor parte de ese costo (58-75 %) es de `mongod`, no de Java. Login es casi todo Java (BCrypt). Con estos números se calcula el techo de cada máquina: X_max de `mezcla-lectura` = 71 req/s en el PC, 20 en el contenedor y 23,3 en la t3.small.

Con el jar arreglado, listar baja a 7,2 ms (PC), 6,9 (contenedor) y 7,1 (t3.small): entre 24 y 31 veces menos. Los techos pasan a 1.288,9, 262,3 y 336,5 req/s. `serverStatus` de MongoDB confirma el N+1: cada listado hace unas 206 `find` y 200 conteos, dos consultas por lobby.

### F2. ¿Qué pasa si hay más datos?

**Cómo.** Medimos el listado con 100, 200, 400, 800 y 1.600 lobbies, cada vez el doble. Si el costo también se duplica, crece en línea recta (exponente 1). Si se cuadruplica, crece al cuadrado (exponente 2).

**Qué salió** (ms de CPU total por listado, PC, `_logs/datos_windows_v3-f2.md` y `datos_windows_v3fix-f2.md`):

| Lobbies | Jar base | Jar arreglado |
|---|---|---|
| 100 | 101,9 | 4,5 |
| 200 | 201,1 | 8,1 |
| 400 | 421,2 | 12,7 |
| 800 | 895,9 | 16,4 |
| 1.600 | 2.157,4 | 26,7 |

Exponente medido con el jar base: 1,1 en el PC, 1,12 en el contenedor y 1,21 en la t3.small. Con el jar arreglado: 0,62 en el PC, 0,50 en el contenedor y 0,64 en la t3.small.

**Qué significa.** El código hace, por cada lobby, un conteo que recorre una colección que también crece. Esperábamos exponente 2, pero medimos alrededor de 1,1. La razón es que el costo tiene dos partes. Una es fija por consulta (armar la consulta, el viaje entre app y base), y es proporcional a N. La otra es recorrer documentos, que es proporcional a N². Con estos tamaños la parte fija pesa más, porque recorrer documentos en RAM es barato. La parte cuadrática ya se nota en el último salto: de 800 a 1.600 el costo se multiplica por 2,4, no por 2. Con más datos seguiría subiendo hacia 2, y por eso con 2.000 lobbies (F7) el jar base colapsa. El jar arreglado crece menos que en línea recta: casi todo su costo es fijo y lo que crece es armar la respuesta, que pasa de 17,4 KB con 100 lobbies a 275,6 KB con 1.600 y que la app serializa a JSON.

**Cómo explicarlo.** Con el jar base, duplicar los lobbies más que duplica el trabajo de la base. A 1.600 lobbies, un solo listado tarda 2,1 s sin ningún otro usuario.

**Por qué importa para los 200 lobbies.** Los 200 lobbies no salen de una medición. Es el tamaño que traíamos de v1 y v2, y lo mantenemos para que todas las corridas sean comparables. Como el costo del listado depende de ese número, usamos F2 para ver si la recomendación cambiaría con otro tamaño. `telemetry/sensibilidad.mjs` combina el costo del listado de F2 con el costo de "ver" de F1 y calcula el techo de la mezcla (50 % listar, 50 % ver) en cada tamaño. Después aplica la regla del 60 % para obtener cuánto sostiene cada opción.

Lo que sostiene cada opción al 60 %, en req/s (`resultados/_logs/sensibilidad_lobbies_20261107.md`):

| Lobbies | PC base | Contenedor base | t3.small base | PC arreglado | Contenedor arreglado | t3.small arreglado |
|---|---|---|---|---|---|---|
| 100 | 89,8 | 24,6 | 27,9 | 1.001 | 181 | 248 |
| 200 | 46,6 | 11,9 | 13,7 | 722 | 155 | 194 |
| 400 | 22,5 | 5,3 | 6,3 | 537 | 126 | 152 |
| 800 | 10,7 | 2,3 | 2,7 | 445 | 96,5 | 106 |
| 1.600 | 4,4 | 0,9 | 1,0 | 301 | 66,2 | 70,4 |

**Qué significa.** Con el jar base, cada vez que se duplican los lobbies lo que aguanta cada máquina baja a menos de la mitad. Con 1.600 lobbies, la t3.small sostiene 1 req/s. Con el arreglo, la t3.small sostiene 70,4 req/s incluso con 1.600 lobbies. Eso es más de lo que sostiene el PC con el jar base y 200 lobbies (46,6 req/s). La recomendación es la misma en todos los tamaños: arreglar el código, y después la máquina más barata alcanza. F7 lo confirma con carga real: con 2.000 lobbies a 10 req/s, el jar base falla en las tres opciones y el arreglado pasa con p95 de 62 ms en la t3.small.

**Límite.** Cada lobby sembrado tiene un solo participante. Con más participantes por lobby, el conteo del jar base recorre una colección más grande y el costo subiría más. Esto no lo medimos.

**Cómo explicarlo.** "Los 200 lobbies los elegimos nosotros, así que los tratamos como una variable. Medimos de 100 a 2.000. En todos los tamaños gana la misma opción."

### F3. ¿Sirve agregar núcleos? (Amdahl)

**Cómo.** Bucle cerrado con 1, 2, 4, 8 y 16 workers en el PC (que tiene 8 hilos para la app), y con 1, 2 y 4 en la t3.small (2 hilos). Si con el doble de workers sale el doble de req/s, el trabajo se reparte bien. Se despeja p, la parte que se puede repartir.

**Qué salió** (`_logs/amdahl_windows_v3-f3.md`, `ec2_t3small-unl/_logs/amdahl_ec2_f3.md`):

| | PC listar | PC login | t3.small listar | t3.small login |
|---|---|---|---|---|
| req/s con 1 worker | 4,9 | 8,9 | 5,7 | 11,9 |
| mejor req/s | 28,8 (8 workers) | 57,7 (16) | 10,2 (4) | 20,9 (4) |
| p (fracción paralela) | 0,981 | 0,945 | 0,743 | 0,828 |
| de 4 a 8 hilos en el PC, o de 1 a 2 en la t3 | +57 % | +84 % | +59 % | +71 % |

**Qué significa.** En el PC el trabajo se reparte casi perfecto hasta llenar los 8 hilos (p = 0,98 en listar). Pasando de 8 workers no mejora o empeora: con 16 workers listar baja a 24,8 req/s, porque no hay más hilos y solo crece la fila. En la t3.small el límite llega enseguida, porque tiene un solo núcleo.

Login (BCrypt) aprovecha mucho el segundo hilo de cada núcleo: +84 % en el PC y +71 % en la t3.small. La sesión 05 dice 15-30 %. BCrypt hace muchas lecturas pequeñas de tablas en la caché L1, y cada una deja el núcleo esperando un momento. El otro hilo usa ese hueco.

**Ojo.** En listar, el "+57 %" no es solo ganancia de SMT: con pocos workers cada uno pasa parte del tiempo esperando a `mongod`, así que los hilos no estaban llenos. En login sí es más limpio, porque 1 worker ya ocupa un hilo entero (98-102 % de un núcleo).

### F4. ¿Qué proceso limita en el contenedor?

**Cómo.** Solo en Docker. Cambiamos la CPU de la app y de `mongod` por separado (1×0,5; 1×1; 1×2; 1×4; 2×1; 4×1) y medimos el máximo de req/s con 16 workers. Si dar más CPU a un proceso sube el máximo, ese proceso era el cuello de botella.

**Qué salió** (req/s con 16 workers, `mezcla-lectura`):

| App × `mongod` (CPU) | Jar base | Jar arreglado |
|---|---|---|
| 1 × 0,5 | 9,2 | 196,7 |
| 1 × 1 | 18,0 | 311,5 |
| 1 × 2 | 26,9 | 319,0 |
| 1 × 4 | 28,6 | 319,3 |
| 2 × 1 | 17,3 | 410,3 |
| 4 × 1 | 17,8 | 410,5 |

**Qué significa.** Con el jar base, darle más CPU a la app (2×1, 4×1) no cambia nada (17-18 req/s). Darle más a `mongod` (1×2) lo sube de 18,0 a 26,9. El cuello es `mongod`. A partir de 1×2 la app llega al 100 % de su CPU y pasa a ser ella el límite (1×4 casi no sube).

Con el jar arreglado pasa al revés. Más CPU para `mongod` no cambia nada (311-319 req/s) y más CPU para la app lo sube a 410. El arreglo le quitó tanto trabajo a `mongod` que el cuello pasó a ser Java. Esto prueba con números que el N+1 era el problema de `mongod`.

### F5. ¿Acertó la predicción? (rampa)

**Cómo.** Con el X_max de F1 armamos una rampa a tasa fija: 10 %, 20 %, 30 %... del techo predicho, 90 s por nivel, hasta que falle dos veces seguidas. Comparamos la CPU predicha (λ × D) con la medida, y el codo predicho con el medido.

**Qué salió** (jar base, `mezcla-lectura`):

| | X_max predicho | Último λ que pasa | Primer λ que falla |
|---|---|---|---|
| PC | 71 | 35,8 (p95 378 ms) | 42,9 (p95 1.325 ms) |
| Contenedor | 20 | 10,2 (p95 442 ms) | 12,5 (p95 1.089 ms) |
| t3.small Unlimited | 23,3 | 11,8 (p95 425 ms) | 14,5 (p95 1.132 ms) |

Con el jar arreglado el techo predicho es 1.288,9 (PC), 262,3 (contenedor) y 336,5 req/s (t3.small), y el último λ que pasa es 1.034 (80 % del techo), 314,3 (120 %) y 267,6 (80 %). La utilización medida fue 70 %, 88 % y 82 %. El contenedor pasa el 120 % porque bajo carga su app gasta unos 2,8 ms por petición, no los 3,8 que midió F1 con un cliente.

**Qué significa.** La CPU medida queda cerca de la predicha (1 a 8 puntos de diferencia con el jar base): en el PC, 55 % medido contra 50 % predicho a 35,8 req/s. Con el jar arreglado el codo sube al 80-90 % del techo en el PC y la t3.small (el contenedor pasa al 120 %), porque un listado cuesta 7 ms y hacen falta unas 140 peticiones en cola para pasar de 1 s (con el base bastan unas 5). El modelo describe bien la máquina. Pero el requisito falla antes del 100 %: en las tres opciones, más o menos al 60 % del techo. Es lo normal en una fila. Cuando el servidor está ocupado más de la mitad del tiempo, las llegadas al azar se juntan y las esperas crecen muy rápido, aunque en promedio sobre CPU. Por eso la regla de recomendación pide no pasar del 60 % de uso.

### F6. ¿Aguanta carga sostenida? (la comparación principal)

**Cómo.** La misma escala en todas las máquinas: 5, 10, 20, 40 y 80 req/s, 600 s (10 minutos) por nivel, tres repeticiones con semillas 1, 2 y 3. Se detiene en el primer nivel que no pasa. Mientras tanto el agente mide todo: CPU, RSS, disco, red y percentiles.

**Qué salió** (p95 en ms; X = no pasa):

| λ | PC base | Contenedor base | t3.small base | PC arreglado | Contenedor arreglado | t3.small arreglado |
|---|---|---|---|---|---|---|
| 5 | 218-245 | 236-245 | 255-276 | 22 | 23 | 15-16 |
| 10 | 218-236 | 408-478 | 393-408 | 22 | 22 | 12-13 |
| 20 | 236-255 | X | X | 21 | 22 | 12-15 |
| 40 | 629-827, X en r3 | – | – | 21 | 21 | 13-14 |
| 80 | X | – | – | 20 | 21 | 16 |

**Qué significa.** Con el código original, la t3.small y el contenedor solo aguantan 10 req/s, y el PC 20 (40 en dos de tres repeticiones). Con el arreglo, las tres aguantan 80 req/s con un p95 de 12 a 23 ms. A 10 req/s eso es entre 10 veces (PC) y 32 veces (t3.small) menos latencia que con el código original. En la t3.small arreglada a 80 req/s la máquina está ocupada solo el 28,8 %. El PC arreglado pasa también 160 y 320 req/s (p95 de 17,7 a 19,2 ms). Cuando un nivel falla el colapso es total: a 20 req/s la t3.small base responde 1,8 a 2,2 req/s con 89-95 % de errores.

**Ojo con el p50.** En `mezcla-lectura` el p50 salta entre 20 y 170 ms según la repetición. La mitad de las peticiones son "ver" (unos 13 ms) y la otra mitad "listar" (unos 200 ms), y la mediana cae en el borde entre los dos grupos. Por eso se compara con p95 y p99.

### F7. ¿Qué pasa con 10 veces más?

**Cómo.** Primero escribimos la predicción del tráfico ×10 en un archivo con fecha y hora (`_logs/prediccion_x10_*.md`), para que nadie diga que la acomodamos después (la del PC se escribió a las 08:49:31 y el generador arrancó a las 08:50:09, hora de Colombia; la carpeta dice 13:49 porque está en UTC). La predicción de los datos ×10 no quedó escrita antes: la extrapolamos después con F2 y pedía al menos 9,5 s de CPU por segundo, más de lo que tiene cualquier opción. El 2026-11-09 lo repetimos bien en la t3.small (F7d, más abajo). Medimos dos casos durante 600 s: 10 veces el tráfico (de 10 a 100 req/s) y 10 veces los datos (2.000 lobbies a 10 req/s).

**Qué salió.**
- Jar base, las tres opciones: 100 req/s da 100 % de errores, y 2.000 lobbies da 99,2 % de errores.
- Jar arreglado: 100 req/s pasa con p95 de 16-21 ms y 2.000 lobbies pasa con p95 de 45-62 ms, con 0 errores en todas.

**Qué significa.** Responde la pregunta "si la carga se multiplica por diez, ¿qué se rompe primero?": la CPU de `mongod`, por el N+1. Y no se arregla comprando una máquina más grande. Hasta el PC, con 8 hilos, colapsa. Se arregla en el código.

**Límite que el modelo no preveía: el heap de la JVM.** En el contenedor con el jar base, la app llegó al 97 % de su cuota con `mongod` al 53 %, no al revés. La JVM toma por defecto un cuarto de la memoria visible como heap (unos 256 MB en un contenedor de 1 GB) y con 1 CPU usa Serial GC, que detiene toda la app en cada recolección. Al acumularse peticiones el heap se llenó (243 de 247 MB), hubo 626 GC completos (19,5 % del tiempo) y con datos ×10 el 77,3 %. La t3.small no sufre eso porque su JVM ve 1,9 GB y toma un heap de 478 MB. Para desplegar el contenedor habría que fijar `-Xmx` en proporción a su límite. Con el jar arreglado el p95 con 2.000 lobbies (45 a 62 ms) es el doble que con 200, porque cada respuesta lleva 10 veces más lobbies.

### F8. ¿Cuánto duran los créditos de la t3? (solo AWS)

**Cómo.** En la t3.small Standard, con 112,3 créditos guardados, mandamos 23 req/s durante 90 minutos y miramos el saldo en CloudWatch. Antes escribimos la predicción: gasta 2 créditos por minuto (2 vCPU al 100 %) y gana 0,4, así que pierde 1,6 por minuto. 112,3 / 1,6 ≈ 70 minutos (`_logs/prediccion_f8_std_20261106_133637.md`).

**Qué salió.** El saldo bajó 8 créditos cada 5 minutos, exactamente 1,6 por minuto, y llegó a 0,1 a los 72 minutos. La predicción acertó con 2 minutos de diferencia.

Ojo: esos 23 req/s ya superaban la capacidad del jar base aun con créditos (en F6 falla a 20). Por eso la corrida tuvo errores desde el primer minuto. Sirvió para medir los créditos, no la capacidad.

**Después, con el saldo en 0** (una corrida por nivel, carpetas `ec2_t3small-std-thr*`): 1 req/s pasa (p95 202 ms), 2 req/s pasa (210 ms), 5 req/s falla (52,7 % de errores) y 10 req/s falla (99,8 %). El modelo predecía un techo de 4,7 req/s con 0,4 vCPU, y 5 queda justo encima. Una t3.small Standard sin créditos y con el jar base sirve solo hasta unos 2 req/s.

**Unlimited, 40 minutos a 10 req/s con el jar base:** la instancia gastó 59,3 créditos por hora, 35,3 más que los 24 que gana. El RSS de la app subió de 310 a 324 MB (de 237 a 245 MB con el arreglo), sin señal de fuga.

**Qué significa.** Standard es la opción descartada: cuando se acaban los créditos la máquina queda al 20 %. Unlimited no se frena, pero cobra (sección 8.1 del informe).

### Pruebas extra del 2026-11-07

**JVM en el PC** (capítulo 7.3). Pregunta: ¿el login es el doble de lento en el PC nativo que en Docker por culpa de Java 25? Cómo: repetimos F1-login con Java 25 y con Temurin 21. Resultado: p50 de 111,9 ms con las dos, contra 59,8 ms en Docker. No es Java. La sospecha está en Windows nativo, pero falta medirla.

**Créditos de la t3.small Unlimited** (sección 8.1). Pregunta: ¿cuánto cobra AWS a cada nivel de carga? Cómo: `telemetry/creditos.mjs` mira cuánto sube o baja el saldo excedente en CloudWatch durante cada nivel de F6. Resultado: el jar arreglado no paga nada extra hasta 40 req/s y paga unos 4,48 USD/mes a 80 req/s. El jar base paga 19,13 USD/mes ya a 10 req/s. Comprobado con F8: 59,3 créditos gastados por hora − 24 ganados = 35,3, igual a la pendiente medida.

**Frecuencia y caché del Xeon** (capítulo 5 del informe, `resultados/_microbench_20261108/`). Pregunta: ¿qué tan rápido es de verdad un hilo de la t3.small, y la CPU espera a la memoria? Cómo: dos programas nuestros (`membench.c`) en otra t3.small del mismo tipo. Uno encadena sumas dependientes de un ciclo cada una, y de ahí sale la frecuencia. El otro recorre memoria en orden aleatorio, y de ahí sale la latencia de cada nivel. Resultado:
- Con un hilo el Xeon sostiene 3,07 GHz (coincide con el turbo de 3,1 GHz de AWS, no con los 2,5 GHz del nombre). Con los dos hilos ocupados, cada uno rinde 2,82 GHz equivalentes, un 8 % menos.
- Latencia por acceso: L1 1,62 ns (5 ciclos), L2 4,54 ns (14 ciclos), L3 unos 25-30 ns (76-92 ciclos), RAM 101-118 ns (310-360 ciclos). Los escalones coinciden con `lscpu` (L1 de 32 KB, L2 de 1 MB). El L3 se nota solo hasta unos 4 MB, no hasta los 35,8 MB del sistema.
- Cota para LobbyLink: aunque cada uno de los ~40.800 documentos que examina un listado base fuera un fallo a RAM de 118 ns, serían 4,8 ms de los 167,4 ms de CPU, un 2,9 %. La CPU del listado no se va esperando memoria sino ejecutando instrucciones, lo que coincide con `us` 39,9 % y `wa` 0,0 %.

**Por qué el mismo código rinde distinto en cada CPU.** El login (BCrypt, cálculo puro) cuesta 56,0 ms en el Ryzen y 83,1 ms en el Xeon, 1,48 veces más. Medido con el mismo microbenchmark: 4,63 GHz dentro del contenedor y 3,07 GHz en el Xeon, cociente 1,51, casi igual. L1 y L2 por núcleo son iguales en los dos (64 KB y 1 MB), así que la caché no explica la diferencia. En cambio el listado cuesta casi igual (169,8 ms en el contenedor contra 167,4 ms en la t3.small): son ~406 consultas que pasan por el kernel, y en Docker la red virtual lo encarece (`sy` 5,2 % ≈ `us` 5,0 %, contra `sy` 7,8 % y `us` 39,9 % en la t3.small). Además el PC le da a LobbyLink 4 núcleos físicos y la t3.small 1: el techo del PC es 3 veces el de la t3.small (71 contra 23,3 req/s), no 4, porque cada petición le cuesta un 31 % más por el efecto de Windows. Con el jar arreglado las dos CPU sobran para 80 req/s, así que la diferencia de hardware no cambia la recomendación.

### Pruebas extra del 2026-11-09 (t3.small, jar arreglado)

Corrieron en una t3.small Unlimited nueva con su generador aparte. Las dos instancias ya están terminadas. Datos en `resultados/ec2_t3small-pend/` y `resultados/ec2_t3small-xmx/`. Detalle en el capítulo 9.1 del anexo técnico.

**F7d. ¿Acierta la predicción con más datos si la escribimos antes?** Cómo: `prediccion_datos.mjs` usó el barrido F2 para predecir la CPU a 10 req/s con 2.000 y 20.000 lobbies, y dejó el archivo con fecha antes de medir (`_logs/prediccion_datos_ec2_20261109_170101.md`). Después corrimos 600 s con cada tamaño.
- 2.000 lobbies: predijo 9 % de CPU y midió 14 %. Pasa, con p95 59,8 ms y 0 errores.
- 20.000 lobbies: predijo 37 % de CPU y falló el 100 % de las peticiones. No fue la CPU sino la memoria. Cada listado devuelve todos los lobbies (unos 3,4 MB de JSON con 20.000) y no cupo en el heap de 478 MB: 95 Full GC y 4 `OutOfMemoryError`, uno de los cuales mató el hilo de Tomcat que acepta conexiones, y por eso fallaron hasta las peticiones de ver un lobby.
- Repetido con `-Xmx1g`: el kernel mató a Java a los 30 s, con 949 MB de Java y unos 580 MB de `mongod` en 1,9 GiB. Más heap no alcanza en esa máquina.

**Qué significa.** El modelo solo mira CPU, así que no podía ver este fallo. La recomendación vale hasta pocos miles de lobbies. Antes de 20.000 hay que paginar el listado, y eso no lo medimos.

**F9. ¿Cuándo empieza a importar el disco?** Cómo: sembramos lobbies directo en `mongod`, con ~3 KB de texto aleatorio cada uno, y pedimos lobbies al azar de 25 a 400 req/s. Una base de 20.000 (62 MB) cabe en la caché. Otra de 1.000.000 (3.117 MB) no cabe en 1,9 GiB de RAM.
- Con la base que cabe, a 400 req/s: 0 % de fallos de caché, 1 IOPS, p95 28 ms.
- Con la que no cabe, a 400 req/s: 12-14 % de fallos, 365 IOPS (el 12 % de lo que da el disco), `wa` 3,4 %, p95 121 ms y p99 1.089 ms. Todos los niveles pasan.
- La CPU llega al 72 % en los dos casos.

**Qué significa.** Aun sin caché, el disco llega a una octava parte de su capacidad cuando la CPU ya va por tres cuartos. El disco sube la cola de la latencia (cada lectura del EBS tarda unos 10 ms), pero no es lo que se llena primero. Esto vale para pedir un lobby a la vez. Un listado que recorra millones de lobbies que no caben sí dependería del disco.

**Equivalencia del arreglo.** `telemetry/comparar_respuestas.mjs` arrancó los dos jars sobre la misma base y comparó 95 respuestas: listados, listados por videojuego y 45 detalles con 0 a 5 cupos libres. Las 95 fueron idénticas (`resultados/_equivalencia_20261109_ec2/`). Sirve para responder "¿cómo saben que el arreglo no cambió lo que responde la API?".

**Límites.** No medimos los fallos de caché de la CPU ni la frecuencia del Ryzen. Los microbenchmarks no corrieron en la misma instancia de F1-F8. Las explicaciones de SMT y del login lento en Windows son hipótesis coherentes con los datos, no mediciones directas.

## Parte 4. Las cuatro preguntas de la sustentación

**¿Por qué ese número y no otro? ¿Cómo lo midieron?**
Todo nivel de carga sale de una medición. F1 dice cuánto cuesta una petición, de ahí sale el techo, y la rampa y el ×10 se construyen sobre ese techo. La escala de F6 (5 a 80) es la misma en todas las máquinas para poder compararlas. Hay dos números elegidos y los dos se declaran como tales. Uno es el requisito de 1.000 ms. Con 300 o 500 ms la recomendación (el arreglo en la t3.small) no cambia, porque con el jar arreglado ningún nivel cambia de resultado. Lo que sí cambia es cuánto aguanta el jar base: con 300 ms la t3 y el contenedor pasarían solo 5 req/s, y con 500 ms el PC solo 20. El otro es el tamaño de datos de 200 lobbies, que viene de nuestras mediciones anteriores, y mostramos que con 100 a 2.000 lobbies la conclusión tampoco cambia. Todo tiene guion y semilla, y se puede repetir.

**¿Y por qué 200 lobbies?** (la van a hacer)
"No sale de una medición. Es un tamaño de referencia que traíamos de las versiones anteriores, para que todas las corridas sean comparables. Como no sabemos cuántos lobbies tendría la aplicación en uso real, lo medimos como variable: el listado con 100, 200, 400, 800 y 1.600 lobbies (F2) y carga sostenida con 2.000 (F7). En todos los tamaños gana la misma opción. Con el código original, la t3.small pasa de sostener 27,9 req/s con 100 lobbies a 1,0 con 1.600. Con el arreglo sostiene 70,4 req/s incluso con 1.600." Si piden el detalle, la tabla está en la sección 4.2 del informe y en `resultados/_logs/sensibilidad_lobbies_20261107.md`.

**¿Qué componente causa ese comportamiento?**
La CPU, y dentro de ella `mongod`. Con el jar base a 10 req/s en la t3.small: `us` 39,9 % y `wa` 0 %, `mongod` al 62 % de un núcleo contra 34 % de la app, 20.412 documentos examinados por petición y 0 % de fallos de caché. El disco no participa (la máquina hace 1 IOPS en promedio contra 354 escrituras con `fsync` por segundo que puede dar). La causa es el N+1 sin índice.

**Si la carga se multiplicara por diez, ¿qué se rompería primero?**
La CPU de `mongod`. Lo predijimos por escrito y lo medimos en F7: el jar base falla en las tres máquinas, tanto con ×10 de tráfico como con ×10 de datos. Con el arreglo pasa todo. Si preguntan por más datos todavía: con ×100 (20.000 lobbies) la t3.small arreglada se rompe por memoria, no por CPU, porque el listado sin paginar no cabe en el heap (F7d).

**¿Hasta qué tamaño vale la recomendación?** (probable)
"Hasta pocos miles de lobbies abiertos. Con 2.000 la t3.small usa 14 % de CPU y p95 de 60 ms. Con 20.000 falla el 100 % por memoria: 95 Full GC y `OutOfMemoryError` con el heap por defecto, y con `-Xmx1g` el kernel mata a Java. El siguiente arreglo es paginar `GET /api/lobbies`, que no medimos."

**¿Y si los datos no caben en memoria? ¿No importa el disco?** (probable)
"Lo probamos en F9 con 1.000.000 de lobbies, 3.117 MB en una máquina de 1,9 GiB. A 400 req/s los fallos de caché suben a 12-14 % y el disco hace 365 IOPS, el 12 % de lo que puede dar, con `wa` 3,4 %. La CPU ya está al 72 %. El disco empeora la cola de la latencia (p95 de 28 a 121 ms), pero no es lo que se llena primero."

**¿Qué opción descartaron y por qué?**
- La t3.small Standard: sin créditos queda a 0,4 vCPU (`steal` 78,8 % con `us` 16,8 % a 10 req/s) y no pasa de 2 req/s con el jar base. Con el arreglado, el gasto de créditos iguala a la ganancia entre 58 y 67 req/s, y por encima la instancia caería a la línea base. Unlimited cuesta lo mismo hasta 40 req/s sin ese riesgo.
- El PC: el más rápido, pero no es un servidor (Windows, sin redundancia, y el generador comparte la máquina), y su equivalente en la nube (c7a.2xlarge, no medida) cuesta 301,31 USD/mes (299,71 de instancia + 1,60 de EBS), 18 veces la t3.small en infraestructura. El PC son 39,84-41,39 USD/mes con la TRM de 3.237,83.
- El contenedor: con 1 CPU por proceso aguanta lo mismo que la t3.small, pero corre en una VM sobre el PC y hereda sus faltas. Además tiene el límite del heap de la JVM (habría que fijar `-Xmx`).

Se elige la t3.small Unlimited con el arreglo, a 16,78 USD/mes de infraestructura hasta 40 req/s y 21,26 USD a 80 req/s (CPU 28,8 %, p95 16 ms, 0 errores). Con transferencia a internet y carga sostenida son 47,81 USD a 10 req/s, 167,80 a 40 y 334,74 a 80. Con el código original, servir 10 req/s en la misma instancia cuesta 35,91 USD/mes, o 67,02 con transferencia.

## Parte 5. Cuidados al presentar

- **El p95 de 10.181 ms es el tope del timeout.** Si lo muestran, digan que es "colapsado", no una latencia.
- **Los ms de CPU de la prueba de JVM.** Las corridas de hoy tienen reposo sucio (15,5-16 %), así que esos ms de CPU tienen ruido. Para comparar usen el p50.
- **La red de Docker.** Las corridas Docker anteriores al 2026-11-07 tienen la red en 0 por un error del agente que ya corregimos. Usen solo `v3fixnet-*` y `v3basenet-*`.
- **F6 del jar arreglado** tiene 2 repeticiones en el PC y en Docker, no 3.
- **Versiones de software.** El PC usa MongoDB 9.0.4 y Java 25. El contenedor y la t3.small usan MongoDB 7.0.45 y Java 21.
- **Microbenchmarks.** Corrieron en otra t3.small del mismo tipo, no en la de F1-F8. La cota del 2,9 % usa latencia de memoria y documentos examinados medidos, no fallos de caché de CPU. No digan "medimos los fallos de caché de la CPU".
- **Predicción de datos ×10.** En F7 no quedó escrita antes de medir. F7d sí la tiene escrita antes, pero solo en la t3.small. En el PC y el contenedor sigue pendiente (paso p8 de `campanas/pendientes_local.sh`).
- **F9 y F7d corrieron en otra t3.small** del mismo tipo, no en la de F1-F8, y solo con el jar arreglado. F9 pide un lobby a la vez: no digan que probamos el listado con datos que no caben.
- **El p50 de 1,7 ms con `-Xmx1g`** no es una latencia buena: son conexiones rechazadas porque Java ya estaba muerto.
- **Lo que viene de fichas y no de mediciones.** El precio de EBS (0,08 USD/GB-mes) es un ejemplo de la página de AWS. El TDP del Ryzen (35 W) es el de la ficha de AMD. Ninguno de los dos se midió.
