# LobbyLink: en qué máquina debe correr

Arquitectura Computacional, UCC, proyecto final. Todas las cifras salen de nuestras corridas en `lobbylink_perfv3/resultados/`. El detalle de cada fase, las tablas completas y la carpeta cruda de cada número están en `anexo_tecnico.md`.

## 1. Introducción

### Qué se hizo

Tomamos una aplicación real, LobbyLink, y le medimos el consumo bajo carga sostenida en tres máquinas: el portátil de un integrante, un contenedor Docker con 1 CPU y 1 GB que fijamos nosotros, y una instancia EC2 t3.small de AWS. En cada una registramos la CPU (promedio, pico y por núcleo), la memoria residente, las IOPS y los MB/s del disco, la red y la latencia p50, p95 y p99.

En la primera ronda vimos que casi todo el costo estaba en un solo endpoint, el listado de lobbies, por un defecto de código de tipo N+1. Lo corregimos sin tocar la base de datos y repetimos las mismas cargas con el código corregido. Por eso el informe compara las tres máquinas dos veces, con el jar original y con el corregido.

### El repositorio con el que trabajamos

LobbyLink es el backend de una aplicación para armar partidas: un usuario publica un lobby para un videojuego y otros se unen hasta llenarlo. Lo escribió Jeferson Morillo para Diseño de Software. Es una API REST en Spring Boot 3.5.14 sobre MongoDB, con 23 endpoints en 7 controladores organizados en controlador → servicio → repositorio de Spring Data. La autenticación es JWT sin estado y las contraseñas se guardan con BCrypt de factor 10. Trae una colección Postman con el recorrido de uso que documenta su autor, y de ella salen nuestras mezclas de peticiones.

Leyendo el código encontramos los dos puntos caros:

- `GET /api/lobbies` (`LobbyServiceImpl.listLobbies`) devuelve todos los lobbies abiertos, sin paginar, y por cada uno hace dos consultas más: `countByLobbyId` para contar participantes y `findById` para traer el videojuego. Con 200 lobbies son unas 406 consultas por petición, y `participaciones.lobbyId` no tiene índice, así que cada conteo recorre la colección.
- El login y el registro ejecutan BCrypt, 2¹⁰ rondas de cálculo dentro de la JVM.

El trabajo ocupa cuatro carpetas. `LobbyLink_backend/` es la aplicación original, empaquetada como `jars/disenofinal-base.jar`. `LobbyLink_backend_nplus1/` es nuestra copia con el arreglo del listado, empaquetada como `jars/disenofinal-nplus1-fix.jar`. `lobbylink_perfv3/telemetry/` tiene las herramientas: `rate.mjs` genera carga a tasa fija, `load.mjs` en bucle cerrado, `agent.mjs` toma la telemetría fuera de la app, `model.mjs` calcula la capacidad y `report.mjs` arma las tablas. `campanas/campana.sh` corre todas las fases en el mismo orden y con los mismos parámetros en las tres máquinas. Los resultados quedan en `lobbylink_perfv3/resultados/`, una carpeta por corrida que nunca se sobrescribe.

### Las cargas preparadas

**Datos de partida.** Cada corrida arranca con una base nueva sembrada con 1 videojuego, 20 usuarios y 200 lobbies de un participante. Empezamos siempre de cero porque el listado recorre todos los lobbies: con una base acumulada, cada corrida mediría una aplicación distinta.

**Cómo llegan las peticiones.** La carga sostenida no simula usuarios con pausas inventadas. `rate.mjs` manda peticiones a una tasa fija λ en req/s, con llegadas de Poisson y semilla fija: llegan al azar alrededor del promedio y la misma semilla repite exactamente la misma secuencia. Cada petición sale a su hora aunque el servidor no haya contestado la anterior, y la latencia se mide desde esa hora, así que un atasco queda registrado. Una petición que tarda más de 10 s cuenta como error.

**Qué peticiones se mandan.** Hay dos mezclas, ambas sacadas de la colección Postman:

- `mezcla-lectura`: 50 % `GET /api/lobbies` (listar) y 50 % `GET /api/lobbies/{id}` (ver un lobby). No crea datos, así que la carga es idéntica del primer al último segundo. Es la mezcla con la que comparamos las máquinas.
- `mezcla-postman`: los seis endpoints del recorrido en partes iguales, un sexto cada uno de registro, login, crear lobby, listar, ver y unirse. Crea un lobby cada seis peticiones y por eso el listado se encarece durante la corrida; solo la usamos para validar el modelo en la rampa.

**Las cargas, en el orden en que corren.** Ninguna tasa es supuesta: cada fase usa lo que midió la anterior.

- **F0, techo del hardware (unos 4 min).** `fio` hace tres pruebas de 60 s sobre un archivo de 1 GiB, sin pasar por la caché del sistema: lectura aleatoria de 4 KiB con 32 peticiones en vuelo (IOPS máximas), escritura de 4 KiB con `fsync` tras cada bloque (lo que hace el journal de MongoDB al confirmar) y lectura secuencial de 1 MiB con 8 en vuelo (MB/s). En AWS, `iperf3` mide además la red entre generador y servidor durante 30 s con 4 conexiones.
- **F1, costo de cada endpoint (6 corridas de 140 s).** Un solo cliente manda una petición, espera la respuesta y manda la siguiente, así que nunca hay cola. Se repite para listar, ver, login, registro, crear y unirse, con 20 s de calentamiento y 120 s medidos. De aquí sale D, los milisegundos de CPU por petición de la app y de `mongod` por separado. Con la ley de utilización, U = λ·D, `model.mjs` predice el techo X_max de cada máquina.
- **F2, crecimiento con los datos (5 corridas de 90 s).** El mismo cliente único lista con bases de 100, 200, 400, 800 y 1.600 lobbies. El ajuste en potencia da el exponente con que crece el costo.
- **F3, paralelismo (60 s por nivel).** Bucle cerrado con 1, 2, 4, 8 y 16 clientes en el PC y 1, 2 y 4 en la t3.small, con dos cargas: solo listar (reparte trabajo entre app y `mongod`) y solo login (BCrypt en la JVM). Da la fracción paralela de Amdahl y la ganancia del segundo hilo de cada núcleo (SMT). No corre en el contenedor.
- **F4, cuotas del contenedor (60 s por nivel).** Seis repartos de CPU: app con 1 CPU y `mongod` con 0,5, 1, 2 o 4, y `mongod` con 1 y la app con 2 o 4. Cada uno con 1, 4 y 16 clientes de `mezcla-lectura`. Si dar más CPU a un contenedor no sube el rendimiento, ese no era el que limitaba.
- **F5, rampa (90 s por nivel).** A tasa fija, del 10 % al 150 % del X_max predicho en pasos de 10 %, con 20 s de calentamiento y 20 s de pausa. Se corta tras dos niveles que fallan. Corre una vez con cada mezcla y compara el codo medido con el predicho.
- **F6, carga sostenida (unos 58 min por repetición).** La misma escala absoluta en las tres máquinas: 5, 10, 20, 40 y 80 req/s de `mezcla-lectura`, 600 s medidos por nivel más 30 s de calentamiento y 60 s de pausa. Son 3.000, 6.000, 12.000, 24.000 y 48.000 peticiones por nivel, 93.000 por repetición si pasan todos. Tres repeticiones con semillas 1, 2 y 3. La corrida se detiene en el primer nivel que falla. Con el código corregido el PC siguió con 160 y 320 req/s. En el PC y el contenedor hay una corrida extra al 50 % y al 80 % del codo propio.
- **F7, carga por diez (600 s por nivel).** Base de 10 req/s, que las tres pasan con el código original. Tráfico por diez: de 10 a 100 req/s con 200 lobbies, 6.000 y 60.000 peticiones. Datos por diez: 10 req/s con 2.000 lobbies. La predicción de `model.mjs` se escribió en `resultados/_logs/` antes de medir.
- **F7d, datos por diez y por cien con predicción previa (600 s cada uno).** 10 req/s de `mezcla-lectura` con 2.000 y con 20.000 lobbies y el código corregido. `prediccion_datos.mjs` escribió la utilización esperada antes de correr.
- **F8, larga duración.** t3.small Unlimited a 10 req/s durante 40 min (24.000 peticiones) y Standard a 23 req/s durante 90 min (124.200). Mide los créditos de CPU y si la memoria de la app crece sin parar.
- **F9, datos que no caben en memoria (300 s por nivel).** Solo `GET /api/lobbies/{id}` con ids al azar, de 25 a 400 req/s. Una base de 20.000 lobbies, unos 60 MB, que cabe en la caché, contra 1.000.000 de lobbies de unos 3 KB cada uno, 3.117 MB, en una t3.small de 1,9 GiB. Los lobbies se insertan directo en `mongod` y están cancelados para que el listado no los devuelva.

**Cuándo pasa un nivel.** El p95 debe ser de 1.000 ms o menos y los errores no deben pasar del 1 % (`telemetry/profiles/umbrales.json`). El límite de latencia lo declaramos nosotros; con el código corregido ningún resultado cambia si es 300 o 500 ms. Si el propio generador se atrasa más de 50 ms en p99, el nivel no cuenta. Para recomendar una máquina a una tasa pedimos además que su recurso más ocupado quede al 60 % o menos.

**Qué mide el agente.** `agent.mjs` toma una muestra por segundo (cada 2 s en Windows): CPU de la máquina en `us`, `sy`, `wa` y `steal`, CPU y RSS de cada proceso, IOPS, MB/s y utilización del disco, bytes de red, frenado de la cuota en Docker, y de `mongod` las consultas, los documentos examinados y los fallos de caché de WiredTiger. `report.mjs` solo usa la ventana medida de cada nivel.

## 2. Entornos

### PC, la máquina física

- **Procesador:** AMD Ryzen 7 7445HS, Zen 4, 2023, TDP de 35 W. 6 núcleos y 12 hilos.
- **Frecuencia:** 3,2 GHz base y 4,7 GHz turbo según AMD. Medimos 4,7 GHz sostenidos en el núcleo 0; un hilo fijado en los núcleos 1 a 3 se queda en 3,15 GHz bajo Windows (`resultados/_microbench_ryzen_20261108/`).
- **Cachés:** 64 KB de L1 y 1 MB de L2 por núcleo, 16 MB de L3 compartidos. Latencias medidas: 0,85 ns en L1, 2,96 ns en L2, 10,7-14,8 ns en L3 y 85,7-112,9 ns en RAM.
- **Memoria:** 15,2 GB visibles, un solo módulo DDR5 de 16 GiB a 5.600 MT/s, es decir un canal.
- **Disco:** SSD NVMe de 512 GB. 41.903 IOPS en lectura aleatoria (375 µs en p50), 1.488 IOPS de escritura con `fsync` y 1.306,8 MB/s secuenciales.
- **Software:** Windows 11 Home, Oracle Java 25, MongoDB 9.0.4 con 7.287 MB de caché de WiredTiger.
- **Lo que ve LobbyLink:** `run.mjs` fija la app y `mongod` en los hilos 0 a 7 (4 núcleos con SMT) y el generador en los hilos 8 a 11. El tráfico va por loopback, sin red real.

### Contenedor `a1m1`, con límites nuestros

- **Procesador:** el mismo Ryzen, visto desde Docker Desktop 29.8.2 sobre la VM Linux de WSL2, que ve 12 CPU y 7,4 GB.
- **Límites:** la app recibe 1 CPU y 1 GB, y `mongod` otro contenedor con 1 CPU y 1 GB (`envs/compose.yml`). La cuota es `cpu.max = 100000 100000`: 100 ms de CPU por cada periodo de 100 ms. Si el contenedor los gasta antes, el kernel lo detiene hasta el siguiente periodo; a eso le llamamos frenado (`throttled`). La cuota limita tiempo, no núcleos: puede usar cualquiera de las 12 CPU, pero en total no pasa de 1.
- **Frecuencia:** 4,63 GHz en cualquier vCPU, más que los 3,15 GHz de Windows nativo fuera del núcleo 0.
- **Memoria efectiva:** `mongod` ve 1 GB y su caché de WiredTiger queda en el mínimo de 256 MB. La JVM toma un cuarto del GB como heap, unos 256 MB, y con 1 CPU visible elige Serial GC.
- **Disco:** archivo virtual de la VM sobre el mismo NVMe. 79.766 IOPS en lectura aleatoria (cota superior, porque Windows puede servir parte desde su caché), 1.155 IOPS con `fsync` y 1.410,6 MB/s.
- **Software:** Eclipse Temurin 21.0.12 y MongoDB 7.0.45.

### EC2 t3.small, la opción de nube

- **Procesador:** Intel Xeon Platinum 8259CL, Cascade Lake, 2019. 2 vCPU, que son los dos hilos de un único núcleo físico.
- **Frecuencia:** 2,5 GHz nominales y hasta 3,1 GHz de turbo según AWS. Medimos 3,07 GHz con un hilo y 2,82 GHz por hilo con los dos ocupados.
- **Cachés:** 64 KB de L1 y 1 MB de L2 para el núcleo. El chip tiene 35,75 MB de L3 compartidos con otros clientes; la latencia medida es 24,7-29,9 ns hasta unos 4 MB y salta a RAM (100,9-118,1 ns) desde 8 MB, así que el L3 que le toca es mucho menor que el de la ficha. L1 1,62 ns y L2 4,54 ns.
- **Memoria:** 1,9 GiB.
- **Disco:** EBS gp3 de 20 GiB, que viaja por la red del centro de datos. 3.049 IOPS en lectura aleatoria con 10 ms en p50 (27 veces el NVMe), 354 IOPS con `fsync` y 127,3 MB/s.
- **Red:** 4.953 Mbit/s hasta el generador, una c7i-flex.large de 2 vCPU y 4 GiB en la misma red privada.
- **Software:** Ubuntu 26.04.1, kernel 7.0.0-1016-aws, Java 21.0.12, MongoDB 7.0.45 con 440 MB de caché.
- **Créditos:** la línea base es el 20 % de cada vCPU y gana 24 créditos por hora. En modo Unlimited puede pasar de ella y AWS cobra el exceso a 0,05 USD por vCPU-hora; en Standard, sin créditos, el hipervisor la deja en 0,4 vCPU y Linux muestra el resto como `steal`. Medimos los dos modos.
- **Precio:** 0,0208 USD por hora bajo demanda en us-east-1.

## 3. Resultados

La tabla junta la carga sostenida F6 con `mezcla-lectura` y los recursos en el último nivel que pasan las tres máquinas, en la repetición r1: 10 req/s con el código original y 80 req/s con el corregido. Latencias en ms; CPU de proceso en porcentaje de un núcleo.

|  | PC original | Contenedor original | t3.small original | PC corregido | Contenedor corregido | t3.small corregido |
| --- | --- | --- | --- | --- | --- | --- |
| Mayor λ que pasa en F6 | 20 req/s (40 en 2 de 3) | 10 req/s | 10 req/s | 80 req/s, y 320 | 80 req/s | 80 req/s |
| p50 / p95 / p99 | 20,7 / 218 / 245 | 72,7 / 408 / 765 | 22,4 / 393 / 605 | 9,8 / 19,9 / 22,4 | 10,6 / 20,7 / 22,4 | 7,8 / 16,4 / 35,9 |
| CPU de la máquina, promedio / pico | 19,4 % / 76 % | 10,2 % / 17,5 % de la VM | 48,2 % / 99,5 % | 15,7 % / 58 % | 6,6 % / 8,8 % de la VM | 28,8 % / 97,1 % |
| Hilo más ocupado, promedio / pico | 66 % / 100 % | 22 % / 41 % | 50 % / 100 % | 65 % / 100 % | 14 % / 20 % | 30 % / 99 % |
| `us` / `wa` / `steal` | 8,9 % / – / – | 5,0 % / 0,0 % / 0 % | 39,9 % / 0,0 % / 0,5 % | 6,0 % / – / – | 2,9 % / 0,0 % / 0 % | 23,8 % / 0,0 % / 1,2 % |
| CPU app / `mongod` | 27 / 77 | 41 / 56 | 34 / 62 | 19 / 22 | 26 / 21 | 33 / 23 |
| RSS app / `mongod` (MB) | 241 / 96 | 217 / 80 | 260 / 189 | 246 / 132 | 219 / 82 | 250 / 162 |
| Disco, IOPS / MB/s | 29 / 1,98 (todo el equipo) | 0 / 0,01 | 1 / 0,01 | 19 / 2,75 (todo el equipo) | 0 / 0,01 | 1 / 0,01 |
| Red de entrada, promedio / pico (MB/s) | loopback | 0,88 / 2,33 | 0,005 / 0,01 | loopback | 1,42 / 2,91 a 40 req/s | 0,037 / 0,052 |
| Red de salida, promedio (MB/s) | loopback | 0,79 | 0,17 | loopback | 0,90 a 40 req/s | 1,39 |
| Documentos examinados por petición | 20.432 | 20.413 | 20.412 | 602 | 602 | 602 |
| Tráfico ×10, 100 req/s | 100 % de errores | 100 % de errores | 100 % de errores | p95 19,9 ms | p95 20,7 ms | p95 16,4 ms |
| Datos ×10, 2.000 lobbies | 99,18 % de errores | 99,18 % de errores | 99,18 % de errores | p95 45,4 ms | p95 45,4 ms | p95 62,2 ms |
| Costo mensual | 39,84-41,39 USD | 6,64-6,92 USD | 35,91 USD | 39,84-41,39 USD | 6,64-6,92 USD | 21,26 USD |

En el PC el agente ve el disco de todo el equipo; la app y `mongod` leen 0 MB/s. Los fallos de caché de WiredTiger son 0 % en las seis columnas.

**CPU por núcleo.** La fila del hilo más ocupado muestra cómo se reparte la carga. En el PC el promedio de la máquina es 19,4 %, pero el hilo más ocupado está en 66 % y llega a 100 %. La carga se concentra en los 8 hilos fijados a LobbyLink (los hilos 8 a 11 son del generador), y dentro de ellos en unos pocos. A 10 req/s hay pocas peticiones en vuelo a la vez, así que el sistema operativo no tiene trabajo para repartir entre los 8. En la t3.small el hilo más ocupado (50 %) casi coincide con el promedio de la máquina (48,2 %): las dos vCPU trabajan por igual, y los picos de 100 % son instantes en que las dos se llenan a la vez. En el contenedor el hilo más ocupado no pasa de 41 %, porque la cuota de 1 CPU se reparte entre las 12 CPU de la VM.

**Red de entrada y de salida.** En la t3.small la entrada es mínima, 0,005 MB/s con el código original y 0,037 MB/s a 80 req/s con el corregido, porque las peticiones son `GET` de unos cientos de bytes. La salida es el tamaño de las respuestas: 17,6 KB por petición en promedio, que a 80 req/s dan 1,41 MB/s calculados contra 1,39 MB/s medidos. En el contenedor la interfaz de la app cuenta también el tráfico con `mongod`, que está en otro contenedor, y por eso la entrada (0,88 MB/s a 10 req/s) supera a la salida: son las respuestas de las ~406 consultas de cada listado que llegan desde `mongod`. En el PC todo va por loopback y el contador de la tarjeta no lo ve. En la t3.small, la única con `iperf3`, la red usa como máximo el 0,22 % de los 4.953 Mbit/s medidos.

El p50 de `mezcla-lectura` salta entre unos 20 y 170 ms según la repetición, porque la mitad de las peticiones ven un lobby (unos 13 ms) y la otra mitad listan (unos 200 ms con el código original) y la mediana cae entre los dos grupos. Por eso comparamos con p95 y p99.

Para cada máquina respondemos las preguntas del enunciado (si aguanta, dónde espera, qué le sobra y qué le falta, cuánto cuesta) y las de la sustentación (qué componente lo causa y qué se rompe primero con la carga por diez).

### PC

**¿Aguanta la carga?** Con el código original aguanta 20 req/s en las tres repeticiones. A 40 req/s pasa dos veces, con p95 de 629 y 827 ms, y falla la tercera, así que 40 no es una tasa fiable. Con el código corregido pasa toda la escala y además 160 y 320 req/s, con p95 de 17,7 a 19,2 ms.

**¿Dónde espera?** En la CPU, y la mayor parte la gasta `mongod`. A 10 req/s con el código original, `mongod` usa 77 % de un núcleo y la app 27 %. En F3 el listado escala casi sin pérdida hasta 28,8 req/s con 8 clientes; ahí `mongod` usa 572 %, la app 153 % y los 8 hilos asignados están llenos. Según Amdahl, la fracción paralela del listado es p = 0,981, así que la parte secuencial es 1,9 % y el techo teórico, 1 / (1 − p), es unas 53 veces el rendimiento con un hilo. El login tiene p = 0,945: 5,5 % secuencial y techo de 18 veces. Con 8 hilos el listado llega a 5,9 veces (28,8 contra 4,9 req/s), lejos de ese techo, así que en el PC el límite son los hilos que le dimos y no la parte secuencial del código. El disco no participa: los datos caben en los 7.287 MB de caché.

**¿Qué componente lo causa?** El número de núcleos. El PC le da a LobbyLink 4 núcleos físicos y la t3.small 1, y por eso su techo con el código original es 3 veces mayor, 71 contra 23,3 req/s. No llega a 4 veces porque cada petición cuesta más en Windows nativo: el login, que es cálculo puro de BCrypt, cuesta 112,1 ms en Windows y 56,0 ms en el contenedor sobre el mismo chip. El contador de frecuencia por hilo lo explica: durante el login los hilos de la app corren a 2.126 MHz ponderados (`20261110_045149_windows_v3frec-f1-login`), contra 4,63 GHz en el contenedor. La razón 4.630 / 2.126 = 2,18 es del orden de la razón de latencias, 1,87. No medimos qué baja el reloj (plan de energía o planificador de Windows).

**¿Qué le sobra y qué le falta?** Le sobran CPU, RAM y disco: con el código corregido a 80 req/s ocupa el 5 % de sus 8 hilos. Le faltan las condiciones de un servidor: es un portátil con Windows, sin IP pública y sin respaldo de energía ni de disco.

**¿Cuánto cuesta?** 129.000-134.000 COP al mes, 39,84-41,39 USD con la TRM del 2026-11-08. Es una estimación nuestra: deprecia 4.000.000 COP en 36 meses y suma la energía de 35 W de TDP a 700-900 COP/kWh, sin el plan de internet. Lo más parecido en AWS, una c7a.2xlarge con 8 núcleos Zen 4, cuesta 301,31 USD al mes y no la medimos.

**¿Qué se rompe con la carga por diez?** Con el código original, la CPU. A 100 req/s `mongod` llega a 568 % y la app a 192 %, el 95 % de los 8 hilos, y el 100 % de las peticiones vence el tiempo límite. Con 2.000 lobbies a 10 req/s responde 0,08 req/s. Con el código corregido no se rompe nada: a 100 req/s ocupa el 6,5 % de los hilos, con 2.000 lobbies el p95 es 45,4 ms y con 20.000 pasa con p95 de 335,7 ms, porque la JVM ve 16 GB y la app llega a 1.938 MB residentes.

### Contenedor

**¿Aguanta la carga?** Con el código original aguanta 10 req/s, con p95 de 408 a 478 ms, y falla en 20. Con el código corregido pasa toda la escala, y en la rampa F5 llega a 314,3 req/s.

**¿Dónde espera?** En la cuota de CPU. Con el código original limita la de `mongod`: con 1 CPU cada uno, F4 da 18,0 req/s; darle 4 CPU a la app lo deja en 17,8, y darle 2 a `mongod` lo sube a 26,9. Cuando la cuota limita, el frenado llega a 3.951-5.160 ms por segundo, así que el kernel tiene detenido al contenedor la mayor parte de cada periodo. Con el código corregido limita la cuota de la app y el máximo con 1 CPU para `mongod` sube a 410 req/s. El disco hace 0 IOPS en promedio y la caché no tiene fallos.

**¿Qué componente lo causa?** La cuota CFS de 1 CPU que pusimos. El Ryzen es más rápido por hilo, pero un listado original cuesta casi lo mismo que en la t3.small, 169,8 contra 167,4 ms, porque cada una de las ~406 consultas cruza la red virtual de Docker y el kernel gasta tanto como el código: `sy` 5,2 % contra `us` 5,0 %. El segundo límite que pusimos sin querer es el heap de la JVM, unos 256 MB por ver 1 GB. Con el tráfico por diez se llenó (243 de 247 MB) y la app pasó el 19,5 % del tiempo en recolecciones completas. Repetimos con `-Xmx700m` (`20261110_051149_docker_v3xmx-a1m1-f7-trafico-x10`): ya no hubo `OutOfMemoryError`, pero a 100 req/s siguió fallando el 100 % con la app al 70 % de media y `mongod` al 101 % de su cuota. El heap era un riesgo real, pero la falla a 100 req/s es la CPU de `mongod`.

**¿Qué le sobra y qué le falta?** Le sobran disco y memoria del contenedor: la app usa 219 MB de su GB. Le falta heap cuando se forma cola o crecen los datos. Como corre sobre el PC, le faltan también las condiciones de un servidor.

**¿Cuánto cuesta?** La sexta parte del PC, porque sus cuotas son 2 de 12 hilos: 21.500-22.400 COP al mes, 6,64-6,92 USD. En AWS lo más parecido es una c7a.large de 2 núcleos y 4 GiB, a 76,53 USD al mes, sin medir.

**¿Qué se rompe con la carga por diez?** Con el código original cede primero la memoria de la JVM y después la CPU: la app llega al 97 % de su cuota, el heap se llena y falla el 100 %; con 2.000 lobbies las recolecciones completas ocupan el 77,3 % del tiempo. Con el código corregido la app usa el 33 % de su cuota a 100 req/s, con p95 de 20,7 ms, y con 2.000 lobbies pasa con p95 de 42,0 ms. Con 20.000 lobbies falla el 100 % aunque la predicción decía 27 % de CPU: el heap de 247 MB no alcanza, y `app.log` registra 1.782 pausas Full GC y 178 `OutOfMemoryError` (`20261110_062413_docker_v3fix-a1m1-f7d-datos-20000`).

### EC2 t3.small

**¿Aguanta la carga?** En Unlimited con el código original aguanta 10 req/s, con p95 de 393 a 408 ms; en 20 req/s responde entre 1,8 y 2,2 req/s y el 88,9 % de las peticiones vence el tiempo límite. Con el código corregido pasa toda la escala con p95 de 12 a 16 ms y 0 errores en las tres repeticiones, y la rampa llega a 267,6 req/s. En Standard sin créditos, el código original solo pasa 2 req/s.

**¿Dónde espera?** En la CPU. A 10 req/s con el código original, `us` 39,9 % con `wa` 0,0 %, y `mongod` usa 62 % de un núcleo contra 34 % de la app. Con un solo cliente el p50 del listado es 153,2 ms y su CPU 167,4 ms: la petición pasa casi todo su tiempo ejecutando consultas. El disco hace 1 IOPS, el 0,28 % de las 354 escrituras con `fsync` que soporta, y son las del journal. La salida de red a 80 req/s es 1,39 MB/s, el 0,22 % de lo que midió `iperf3`. En Standard sin créditos la espera aparece como `steal`: 78,8 % de `steal` y 16,8 % de `us` a 10 req/s.

**¿Qué componente lo causa?** El único núcleo físico. En F3 deja de rendir más con 2 clientes, porque sus dos vCPU comparten el núcleo, mientras el PC sigue subiendo hasta 8. Amdahl lo muestra: en la t3.small la fracción paralela sale p = 0,743 en el listado y 0,828 en el login, contra 0,981 y 0,945 en el PC, con el mismo código. Si la parte secuencial fuera del código, saldría igual en las dos máquinas. El 26 % "secuencial" de la t3.small es en realidad el núcleo compartido: el segundo cliente no recibe un núcleo nuevo, sino el segundo hilo del mismo, que aporta +59 % en el listado y +71 % en el login en lugar de +100 %. Ese núcleo además es más lento por hilo: con el mismo Java y el mismo MongoDB, el login cuesta 83,1 ms en el Xeon y 56,0 ms en el Ryzen, 1,48 veces, y la frecuencia medida da 4,63 / 3,07 = 1,51. La memoria no es la causa: si cada uno de los ~40.800 documentos que examina un listado fuera un fallo a RAM de 118 ns, sumarían 4,8 ms de los 167,4 ms, un 2,9 %. Encima del núcleo está la línea base del 20 %, que el hipervisor impone en Standard y AWS cobra en Unlimited.

**¿Qué le sobra y qué le falta?** Le sobran disco y red. Mientras el nivel pasa también le sobra memoria: usa 449 de 1.905 MB y pasa el 0,42 % del tiempo en pausas del GC; en los 40 minutos de F8 el RSS de la app sube de 310 a 324 MB, sin señal de fuga. Le falta CPU, un solo núcleo racionado con créditos.

El disco sigue sobrando aunque los datos no quepan en memoria. En F9, con 1.000.000 de lobbies (3.117 MB contra 1,9 GiB de RAM y 440 MB de caché), los fallos de caché subieron de 0 % a 12-14 % y a 400 req/s el disco hizo 365 IOPS y 12,9 MB/s, con `wa` 3,4 % y 21 % de utilización: 0,9 lecturas por petición, el 12 % de las 3.049 IOPS de F0. El p95 subió de 28 a 121 ms y el p99 de 581 a 1.089 ms, pero todos los niveles pasaron. La CPU llegó al 72 % con y sin la base en caché, así que el núcleo sigue llenándose primero.

**¿Cuánto cuesta?** La instancia son 15,18 USD al mes (730 h × 0,0208 USD) y el EBS 1,60 USD: base de 16,78 USD. A eso se suman los créditos medidos en CloudWatch. Con el código original a 10 req/s los créditos suman 19,13 USD y el total es 35,91 USD: los créditos cuestan más que la instancia. Con el código corregido no paga créditos hasta 40 req/s, porque la CPU queda en 14,9 %, bajo la línea base; a 80 req/s paga 4,48 USD y el total es 21,26 USD. Si los clientes estuvieran en internet todo el mes, la transferencia de salida (0,09 USD/GB después de 100 GB gratis) subiría el total a 47,81 USD a 10 req/s, 167,80 a 40 y 334,74 a 80.

**¿Qué se rompe con la carga por diez?** Con el código original, la CPU: a 100 req/s llega a 99,9 % y falla el 100 %, como predijo el modelo con 429 % de las 2 vCPU. Con el código corregido la CPU queda en 34 % a 100 req/s, contra 30 % predicho, y con 2.000 lobbies el p95 es 62,2 ms. Con cien veces los datos, 20.000 lobbies a 10 req/s, se rompe la memoria y no la CPU: la predicción era 37 % de CPU, pero falló el 100 %. La JVM tomó un heap de 478 MB; cada listado con 2.000 lobbies ya pesa unos 340 KB de JSON, así que con 20.000 serían unos 3,4 MB por respuesta antes de contar los objetos intermedios. `app.log` muestra 95 pausas Full GC y 4 `OutOfMemoryError`, uno de los cuales mató el hilo `http-nio-8080-Poller` de Tomcat y tumbó también las consultas de un lobby. Con `-Xmx1g` el kernel mató a Java a los 30 s, con 949 MB residentes y `mongod` ocupando unos 580 MB: en 1,9 GiB un heap más grande no cabe.

## 4. Respuestas para la aplicación

**¿Dónde espera LobbyLink?** En la CPU, en las tres máquinas y con los dos jars. La prueba más limpia es la t3.small original a 10 req/s: `us` 39,9 %, `wa` 0,0 %, 1 IOPS y 0,03 % de la red disponible. `mongod` gasta entre el 58 y el 75 % del costo del listado, porque cada listado hace unas 206 `find` y 200 conteos. El disco no participa porque los datos ocupan unos 10 MB y caben en la caché, con 0 % de fallos en todas partes. Cuando no caben (F9, 3.117 MB) el disco aparece, pero a 400 req/s usa el 12 % de sus IOPS y la CPU se llena antes.

**¿Por qué ese número y no otro?** Porque sale de U = λ·D con D medido en F1. La rampa F5 midió una utilización a entre 1 y 8 puntos de la predicha. Fuera del rango medido el modelo acierta menos: con 2.000 lobbies en la t3.small predijo 9 % y midió 14 %, y con 20.000 predijo 37 % de CPU y la app se quedó sin memoria, un recurso que el modelo no incluye. Antes del techo de CPU falla la latencia: con el código original un listado ocupa la CPU 150-210 ms y basta una cola de unas 5 peticiones para pasar de 1 s, así que el codo cae al 50-62 % del techo. Con 7 ms por listado hacen falta unas 140 en cola y el codo sube al 80-90 %.

**¿Qué componente causa cada número?**

- El número de núcleos explica el techo: 4 en el PC contra 1 en la t3.small. La parte secuencial del código es pequeña (1,9 % en el listado y 5,5 % en el login, medidas en el PC), así que LobbyLink sí aprovecharía más núcleos. La p más baja de la t3.small (0,743) no es código secuencial, sino sus dos hilos sobre un único núcleo.
- El reparto por núcleo confirma dónde está el trabajo: en el PC el hilo más ocupado está al 66 % con la máquina al 19,4 %, y en la t3.small las dos vCPU están parejas (50 % contra 48,2 %).
- La frecuencia por hilo explica el costo de BCrypt: 1,48 veces más caro en el Xeon, cuya frecuencia medida es 1,51 veces menor, y casi el doble en Windows nativo, donde el reloj de los hilos de la app baja a 2.126 MHz.
- El SMT explica que la t3.small toque su máximo con 2 clientes. El segundo hilo de un núcleo aporta +84 % en login en el PC y +71 % en la t3.small.
- La cuota CFS explica el frenado del contenedor, y el límite de memoria que ve la JVM explica su heap de 256 MB.
- La línea base del hipervisor explica el 78,8 % de `steal` en Standard.
- La RAM y la caché de WiredTiger explican que el disco no importe.

**Si la carga se multiplicara por diez, ¿qué se rompería primero?** Con el código original, la CPU, por el listado con N+1, en las tres máquinas y en los dos escenarios. La predicción escrita antes de medir daba 141 % de los hilos del PC, 499 % de la cuota de `mongod` en el contenedor y 429 % de las vCPU de la t3.small, y se midió 100 % de errores con tráfico por diez y 99,18 % con datos por diez. El listado examina N² documentos, y con 2.000 lobbies esa parte cuadrática ya es el 42-67 % de la CPU de `mongod`. Con el código corregido no se rompe nada a diez veces. A cien veces los datos se rompe la memoria de la JVM en las dos máquinas donde el heap por defecto es pequeño (247 MB en el contenedor, 478 MB en la t3.small), y solo el PC, con heap de varios GB, pasa.

**¿Qué opción descartamos y por qué?**

- **t3.small Standard.** Sin créditos atiende 2 req/s con el código original. Con el corregido, el gasto de créditos iguala a la ganancia entre 58 y 67 req/s, y por encima cae a la línea base. Unlimited cuesta lo mismo hasta 40 req/s sin ese riesgo.
- **PC.** Es la opción con más capacidad medida, pero no es un servidor y su costo depende de supuestos nuestros. Con transferencia incluida, la t3.small cuesta más que el PC desde unos 8 req/s sostenidos, así que no lo descartamos por precio sino por operación.
- **Contenedor.** Pasa la misma carga que la t3.small, pero corre sobre el PC con sus mismas carencias, y con 20.000 lobbies falla por heap.
- **c7a.2xlarge.** Es el equivalente del PC en AWS, a 301,31 USD al mes, 18 veces la t3.small, para una capacidad que LobbyLink corregido no necesita.

**Recomendación.** LobbyLink con el arreglo del N+1 en una EC2 t3.small en modo Unlimited con 20 GiB de EBS gp3: 16,78 USD al mes hasta 40 req/s y 21,26 USD a 80 req/s. A 80 req/s la CPU queda en 28,8 %, bajo la regla del 60 %, con p95 de 16 ms y 0 errores en 3 repeticiones; con el tráfico por diez usa el 34 %. Vale mientras la base tenga pocos miles de lobbies abiertos: con 2.000 pasa y con 20.000 falla por memoria. Si hubiera que desplegar el código original, sería la misma instancia solo hasta 10 req/s, por 35,91 USD al mes, y ninguna máquina resistiría la carga por diez.

## 5. Cambios y mejoras visibles

El arreglo, en `LobbyLink_backend_nplus1/`, cambia solo `LobbyServiceImpl`. Cuenta los participantes de todos los lobbies con una sola agregación en lugar de un conteo por lobby, y busca todos los videojuegos a la vez con `findAllById` en lugar de uno por lobby. No agrega índices ni cambia el modelo de datos. `telemetry/comparar_respuestas.mjs` arrancó los dos jars sobre la misma base y comparó 95 respuestas (listados completos, filtrados por videojuego y detalles de 45 lobbies con 0 a 5 cupos libres): fueron idénticas campo por campo en la t3.small (`resultados/_equivalencia_20261109_ec2/`) y en el PC.

Lo que se vio en las mediciones:

- **Costo del listado.** Bajó de 220,3 a 7,2 ms de CPU en el PC, de 169,8 a 6,9 en el contenedor y de 167,4 a 7,1 en la t3.small, entre 24 y 31 veces menos. Los documentos examinados por petición bajaron de 20.412 a 602, y en la t3.small a 10 req/s las operaciones de `mongod` bajaron de 1.998 a 54 por segundo.
- **Techo.** El predicho subió de 71 a 1.288,9 req/s en el PC, de 20 a 262,3 en el contenedor y de 23,3 a 336,5 en la t3.small.
- **Carga sostenida.** El mayor nivel que pasan las tres subió de 10 a 80 req/s, el tope de la escala, y el p95 bajó de 393-478 ms a 12-23 ms.
- **Crecimiento con los datos.** El exponente del costo contra el número de lobbies bajó de 1,10-1,21 a 0,50-0,64. Con 1.600 lobbies un listado pasó de 2,1-2,4 s a 22-29 ms de CPU.
- **Carga por diez.** Las tres máquinas pasaron de fallar a pasar con 0 errores, en tráfico y en datos.
- **Costo.** En la t3.small a 10 req/s los créditos bajaron de 19,13 USD al mes a 0, y la infraestructura de 35,91 a 16,78 USD.
- **Quién limita.** Con el código original limita `mongod`. Con el corregido la app gasta algo más, 3,6 contra 2,3 ms por petición en la t3.small, y en el contenedor la cuota de la app es la primera que se llena.

La comparación que resume el trabajo: pasar de la t3.small al PC multiplica por 3 el techo del código original; corregir el código en la misma t3.small lo multiplica por 14.

## 6. Dónde falla ahora y qué falta decir

**Dónde se rompe ahora.** Con el código corregido ningún nivel de F6 ni de F7 falla. El límite sigue siendo la CPU, pero a tasas entre 27 y 52 veces mayores: en la rampa el último nivel que pasa es 267,6 req/s en la t3.small (80 % de su techo predicho de 336,5), 314,3 en el contenedor y 1.034 en el PC. La t3.small Standard llega antes, entre 58 y 67 req/s, cuando se le acaban los créditos. Y con 20.000 lobbies fallan por memoria la t3.small y el contenedor, mientras el PC pasa con p95 de 335,7 ms.

**Lo que el arreglo no resolvió.**

- El listado sigue sin paginación. Con 2.000 lobbies el p95 es el doble que con 200 (42-62 ms contra 20-22 ms), y con 20.000 la respuesta no cabe en el heap de la t3.small ni del contenedor. Paginar `GET /api/lobbies` es el siguiente arreglo y no lo medimos.
- El costo sigue creciendo con el tamaño de la base, con exponente 0,50-0,64, y `participaciones.lobbyId` sigue sin índice.
- El login no cambió. BCrypt cuesta 83,6 ms de CPU en la t3.small, así que sus 2 vCPU alcanzan para unos 24 logins por segundo como máximo. `mezcla-lectura` no tiene logins y por eso ese límite no aparece en F6; en `mezcla-postman`, que sí los tiene, el codo queda al 51-71 % del techo.
- El heap por defecto de la JVM es un cuarto de la memoria visible. En una máquina o contenedor chico hay que fijarlo con `-Xmx` en proporción al límite, sin pasarse de lo que deja `mongod`.

**Lo que falta medir o decir.**

- Las mezclas salen de la colección Postman, no de uso real; `mezcla-lectura` no tiene escrituras ni BCrypt, y cada lobby sembrado tiene un solo participante.
- F9 solo se midió en la t3.small y pidiendo un lobby a la vez. Un listado sin filtro sobre millones de lobbies sí dependería de los 10 ms por lectura del EBS.
- En el PC y el contenedor el generador corre en el mismo equipo, aunque en otros hilos, y Docker corre sobre WSL2, no sobre Linux nativo. Medimos un solo tipo de instancia; de la c7a.2xlarge y la c7a.large solo tenemos el precio.
- Las explicaciones de SMT, frecuencia y memoria salen de microbenchmarks y del contador de frecuencia de Windows, no de contadores de hardware. No sabemos por qué Windows baja el reloj en los hilos de la app ni por qué sostiene el turbo solo en el núcleo 0.
- En el PC, los endpoints baratos de F1 tienen de 10 a 13 muestras, menos de las 30 que pide el modelo. F6 con el código corregido tiene 2 repeticiones en el PC y el contenedor. Las pendientes de créditos salen de 2 a 5 puntos de CloudWatch por nivel. F7d tiene una sola repetición por tamaño, y el reposo del PC en F7d fue 11,6-12,3 %, sobre el límite del 5 %.
- El costo del PC usa precio, vida útil, tarifa y TDP supuestos, no un vatímetro. El costo de transferencia supone que toda la salida va a internet durante 730 h.
- El proyecto no tiene pruebas automáticas (`src/test` está vacío). El arreglo lo validamos con F1 a F8, la colección Postman y la comparación de 95 respuestas.

## Datos crudos y guiones

- **Datos crudos:** `lobbylink_perfv3/resultados/`, una carpeta por corrida. Tablas del modelo, la validación y los créditos en `resultados/_logs/`; precios y costos de AWS en `resultados/_aws_*`; F9 y F7d de la t3.small en `resultados/ec2_t3small-pend/` y la repetición con `-Xmx1g` en `resultados/ec2_t3small-xmx/`.
- **Guiones:** `campanas/campana.sh`, `campanas/campana_jar.sh`, `campanas/pendientes_local.sh` y la carpeta `telemetry/`.
- **Visor:** `dashboard/index.html` muestra todas las corridas.
- **Índice y comandos:** los anexos A y B de `anexo_tecnico.md` unen cada sección con sus carpetas y dan los comandos para repetir cada fase.
