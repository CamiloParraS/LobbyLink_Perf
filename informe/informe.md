# LobbyLink: en qué máquina debe correr

Arquitectura Computacional, UCC, proyecto final. Todas las cifras salen de nuestras corridas en `lobbylink_perfv3/resultados/`. El detalle de cada fase, las tablas completas y la carpeta cruda de cada número están en `anexo_tecnico.md`.

## 1. Introducción

### Qué se hizo

Tomamos una aplicación real, LobbyLink, y le medimos el consumo bajo carga sostenida en tres máquinas: el portátil de un integrante, un contenedor Docker con 1 CPU y 1 GB que fijamos nosotros, y una instancia EC2 t3.small de AWS. En cada una registramos la CPU (promedio, pico y por núcleo), la memoria residente, las IOPS y los MB/s del disco, la red de entrada y salida, y la latencia p50, p95 y p99.

En la primera ronda vimos que casi todo el costo estaba en un solo endpoint, el listado de lobbies, por un defecto de código de tipo N+1. Lo corregimos sin tocar la base de datos y repetimos las mismas cargas con el código corregido. Por eso el informe compara las tres máquinas dos veces, con el jar original y con el corregido.

### El repositorio con el que trabajamos

LobbyLink es el backend de una aplicación para armar partidas: un usuario publica un lobby para un videojuego y otros se unen hasta llenarlo. Lo escribió Jeferson Morillo para Diseño de Software. Es una API REST en Spring Boot 3.5.14 sobre MongoDB, con 23 endpoints en 7 controladores organizados en controlador → servicio → repositorio. La autenticación es JWT sin estado y las contraseñas se guardan con BCrypt de factor 10. Trae una colección Postman con el recorrido de uso de su autor, y de ella salen nuestras mezclas de peticiones.

Leyendo el código encontramos los dos puntos caros:

- `GET /api/lobbies` (`LobbyServiceImpl.listLobbies`) devuelve todos los lobbies abiertos, sin paginar, y por cada uno hace dos consultas más: `countByLobbyId` para contar participantes y `findById` para traer el videojuego. Con 200 lobbies son unas 406 consultas por petición, y `participaciones.lobbyId` no tiene índice, así que cada conteo recorre la colección.
- El login y el registro ejecutan BCrypt, 2¹⁰ rondas de cálculo dentro de la JVM.

### Las cargas preparadas

**Datos de partida.** Cada corrida arranca con una base nueva: 1 videojuego, 20 usuarios y 200 lobbies de un participante. Empezamos de cero porque el listado recorre todos los lobbies, y con una base acumulada cada corrida mediría una aplicación distinta.

**Cómo llegan las peticiones.** `rate.mjs` manda peticiones a una tasa fija λ en req/s, con llegadas de Poisson y semilla fija, de modo que la misma semilla repite la misma secuencia. Cada petición sale a su hora aunque el servidor no haya contestado la anterior, y la latencia se mide desde esa hora, así que un atasco queda registrado. Una petición de más de 10 s cuenta como error.

**Qué peticiones se mandan.** Las dos mezclas salen de la colección Postman:

- `mezcla-lectura`: 50 % listar (`GET /api/lobbies`) y 50 % ver un lobby (`GET /api/lobbies/{id}`). No crea datos, así que la carga es la misma del primer al último segundo. Con ella comparamos las máquinas.
- `mezcla-postman`: un sexto cada uno de registro, login, crear lobby, listar, ver y unirse. Crea lobbies durante la corrida, así que solo la usamos para validar el modelo en la rampa.

**Las pruebas, en orden.** Ninguna tasa es supuesta: cada prueba usa lo que midió la anterior. En el texto las llamamos por su nombre; el código entre paréntesis (F0 a F9) es el que llevan las carpetas de `resultados/` y el anexo.

| Código | Prueba | Qué responde | Cómo se hizo |
| --- | --- | --- | --- |
| F0 | Capacidad del hardware | ¿Cuánto dan el disco y la red sin la aplicación? | `fio`, 60 s por prueba sobre 1 GiB: lectura aleatoria de 4 KiB (IOPS), escritura de 4 KiB con `fsync` (lo que hace el journal de MongoDB) y lectura secuencial de 1 MiB (MB/s). En AWS, `iperf3` mide la red durante 30 s. |
| F1 | Costo por petición | ¿Cuántos ms de CPU gasta cada endpoint, y qué techo predice eso? | Un solo cliente, sin cola, 20 s de calentamiento y 120 s medidos por endpoint. Da D, los ms de CPU por petición de la app y de `mongod`. Con U = λ·D, `model.mjs` predice el techo X_max de cada máquina. |
| F2 | Crecimiento con los datos | ¿Cuánto se encarece el listado al crecer la base? | El listado con 100, 200, 400, 800 y 1.600 lobbies, 90 s cada uno. |
| F3 | Paralelismo | ¿Cuánto aprovecha LobbyLink más núcleos e hilos? | Bucle cerrado de 1 a 16 clientes en el PC y de 1 a 4 en la t3.small, 60 s por nivel, con solo listar y solo login. Da la fracción paralela de Amdahl y la ganancia de SMT. |
| F4 | Reparto de cuotas del contenedor | ¿Limita la cuota de la app o la de `mongod`? | Seis repartos de CPU entre la app y `mongod`. |
| F5 | Rampa hasta el techo | ¿Dónde está el codo real, comparado con el predicho? | Del 10 % al 150 % del X_max predicho, 90 s por nivel, con las dos mezclas. |
| F6 | Carga sostenida | ¿Qué tasa aguanta cada máquina durante 10 minutos? | 5, 10, 20, 40 y 80 req/s de `mezcla-lectura`, 600 s medidos por nivel: 3.000 a 48.000 peticiones por nivel y 93.000 por repetición, unos 58 min. Tres repeticiones con semillas 1, 2 y 3. Se detiene en el primer nivel que falla. |
| F7 | Carga por diez | ¿Qué se rompe con diez veces el tráfico o los datos? | Sobre la base de 10 req/s: tráfico de 10 a 100 req/s con 200 lobbies, y datos con 2.000 lobbies a 10 req/s, 600 s cada uno. La predicción se escribió antes de medir. |
| F7d | Datos por diez y por cien | ¿Aguanta el código corregido bases mucho más grandes? | 10 req/s con 2.000 y 20.000 lobbies y el código corregido, 600 s, con la predicción escrita antes. |
| F8 | Larga duración | ¿Se agotan los créditos de CPU o hay fugas de memoria? | t3.small Unlimited a 10 req/s durante 40 min y Standard a 23 req/s durante 90 min. |
| F9 | Datos fuera de memoria | ¿Aparece el disco cuando la base no cabe en la caché? | Ver lobbies al azar de 25 a 400 req/s, 300 s por nivel, con 20.000 lobbies (60 MB, caben en la caché) contra 1.000.000 (3.117 MB) en la t3.small de 1,9 GiB. |

**Cuándo pasa un nivel.** p95 ≤ 1.000 ms y errores ≤ 1 % (`telemetry/profiles/umbrales.json`). El límite lo declaramos nosotros; con el código corregido ningún resultado cambia si es 300 o 500 ms. Para recomendar una máquina pedimos además que su recurso más ocupado quede al 60 % o menos. El agente toma una muestra por segundo (cada 2 s en Windows) de CPU, memoria, disco, red, frenado de cuota y contadores de `mongod`.

## 2. Entornos

### PC, la máquina física

- **Procesador:** AMD Ryzen 7 7445HS, Zen 4, 2023, TDP de 35 W. 6 núcleos y 12 hilos.
- **Frecuencia:** 3,2 GHz base y 4,7 GHz turbo según AMD. Medimos 4,7 GHz sostenidos en el núcleo 0; un hilo fijado en los núcleos 1 a 3 se queda en 3,15 GHz bajo Windows.
- **Cachés:** 64 KB de L1 y 1 MB de L2 por núcleo, 16 MB de L3 compartidos. Latencias medidas: 0,85 ns en L1, 2,96 ns en L2, 10,7-14,8 ns en L3 y 85,7-112,9 ns en RAM.
- **Memoria:** 15,2 GB visibles, un módulo DDR5 de 16 GiB a 5.600 MT/s, un solo canal.
- **Disco:** SSD NVMe de 512 GB. 41.903 IOPS en lectura aleatoria (375 µs en p50), 1.488 IOPS con `fsync` y 1.306,8 MB/s secuenciales.
- **Software:** Windows 11 Home, Oracle Java 25, MongoDB 9.0.4 con 7.287 MB de caché de WiredTiger.
- **Lo que ve LobbyLink:** la app y `mongod` fijados en los hilos 0 a 7 (4 núcleos con SMT), el generador en los hilos 8 a 11. El tráfico va por loopback.

### Contenedor 1+1, con límites nuestros

- **Procesador:** el mismo Ryzen, desde Docker Desktop 29.8.2 sobre la VM Linux de WSL2 (12 CPU y 7,4 GB). Medimos 4,63 GHz en cualquier vCPU.
- **Límites:** la app tiene 1 CPU y 1 GB, y `mongod` otro contenedor con 1 CPU y 1 GB (en las carpetas, `a1m1`: app 1 CPU, `mongod` 1 CPU). La cuota es `cpu.max = 100000 100000`: 100 ms de CPU por cada periodo de 100 ms. Si el contenedor los gasta antes, el kernel lo detiene hasta el siguiente periodo; a eso le llamamos frenado (`throttled`).
- **Memoria efectiva:** `mongod` ve 1 GB y su caché de WiredTiger queda en 256 MB. La JVM toma un cuarto del GB como heap, unos 256 MB, y con 1 CPU visible elige Serial GC.
- **Disco:** archivo virtual sobre el mismo NVMe. 79.766 IOPS en lectura aleatoria (cota superior, porque Windows puede servir parte desde su caché), 1.155 IOPS con `fsync` y 1.410,6 MB/s.
- **Software:** Eclipse Temurin 21.0.12 y MongoDB 7.0.45.

### EC2 t3.small, la opción de nube

- **Procesador:** Intel Xeon Platinum 8259CL, Cascade Lake, 2019. 2 vCPU, que son los dos hilos de un único núcleo físico.
- **Frecuencia:** hasta 3,1 GHz según AWS. Medimos 3,07 GHz con un hilo y 2,82 GHz por hilo con los dos ocupados.
- **Cachés:** 64 KB de L1 (1,62 ns) y 1 MB de L2 (4,54 ns). El chip tiene 35,75 MB de L3 compartidos con otros clientes; la latencia es 24,7-29,9 ns hasta unos 4 MB y salta a RAM (100,9-118,1 ns) desde 8 MB, así que el L3 que le toca es mucho menor que el de la ficha.
- **Memoria:** 1,9 GiB.
- **Disco:** EBS gp3 de 20 GiB por la red del centro de datos. 3.049 IOPS en lectura aleatoria con 10 ms en p50 (27 veces el NVMe), 354 IOPS con `fsync` y 127,3 MB/s.
- **Red:** 4.953 Mbit/s hasta el generador, una c7i-flex.large en la misma red privada.
- **Software:** Ubuntu 26.04.1, Java 21.0.12, MongoDB 7.0.45 con 440 MB de caché.
- **Créditos y precio:** línea base del 20 % por vCPU y 24 créditos por hora. En Unlimited puede pasar de ella y AWS cobra el exceso a 0,05 USD por vCPU-hora; en Standard, sin créditos, el hipervisor la deja en 0,4 vCPU y Linux muestra el resto como `steal`. Cuesta 0,0208 USD por hora en us-east-1.

## 3. Resultados

La tabla junta la carga sostenida (F6) con `mezcla-lectura` en el último nivel que pasan las tres máquinas, repetición 1: 10 req/s con el código original y 80 req/s con el corregido. Latencias en ms; CPU de proceso en porcentaje de un núcleo.

|  | PC original | Contenedor original | t3.small original | PC corregido | Contenedor corregido | t3.small corregido |
| --- | --- | --- | --- | --- | --- | --- |
| Mayor λ que pasa en la carga sostenida | 20 req/s (40 en 2 de 3) | 10 req/s | 10 req/s | 80 req/s, y 320 | 80 req/s | 80 req/s |
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

En el PC el agente ve el disco de todo el equipo; la app y `mongod` leen 0 MB/s. Los fallos de caché de WiredTiger son 0 % en las seis columnas. Comparamos con p95 y p99 porque el p50 cae entre los dos grupos de la mezcla (ver, unos 13 ms; listar, unos 200 ms con el código original) y salta de 20 a 170 ms entre repeticiones.

**CPU por núcleo.** En el PC la máquina promedia 19,4 %, pero el hilo más ocupado está en 66 % y llega a 100 %: la carga cae en los 8 hilos fijados a LobbyLink y, a 10 req/s, con pocas peticiones en vuelo, en unos pocos de ellos. En la t3.small el hilo más ocupado (50 %) casi coincide con el promedio (48,2 %): las dos vCPU trabajan por igual. En el contenedor no pasa de 41 %, porque la cuota de 1 CPU se reparte entre las 12 CPU de la VM.

**Red de entrada y de salida.** En la t3.small la entrada es mínima, 0,005 a 0,037 MB/s, porque las peticiones son `GET` de unos cientos de bytes. La salida es el tamaño de las respuestas: 17,6 KB por petición, que a 80 req/s dan 1,41 MB/s calculados contra 1,39 MB/s medidos, el 0,22 % de lo que midió `iperf3`. En el contenedor la interfaz de la app cuenta también el tráfico con `mongod`, y por eso la entrada (0,88 MB/s) supera a la salida: son las respuestas de las ~406 consultas de cada listado. En el PC todo va por loopback y la tarjeta no lo ve.

Para cada máquina respondemos las preguntas del enunciado y de la sustentación.

### PC

**¿Aguanta la carga?** Con el código original aguanta 20 req/s en las tres repeticiones; a 40 pasa dos veces (p95 de 629 y 827 ms) y falla la tercera, así que 40 no es fiable. Con el código corregido pasa toda la escala y además 160 y 320 req/s, con p95 de 17,7 a 19,2 ms.

**¿Dónde espera?** En la CPU, sobre todo en `mongod`. En la prueba de paralelismo (F3) el listado escala casi sin pérdida hasta 28,8 req/s con 8 clientes, con `mongod` a 572 %, la app a 153 % y los 8 hilos llenos. Según Amdahl la fracción paralela del listado es p = 0,981: 1,9 % secuencial y techo teórico de 1 / (1 − p) ≈ 53 veces. El login tiene p = 0,945: 5,5 % secuencial y techo de 18 veces. Con 8 hilos el listado llega a 5,9 veces, lejos de ese techo, así que el límite son los hilos que le dimos y no la parte secuencial del código. El disco no participa: los datos caben en los 7.287 MB de caché.

**¿Qué componente lo causa?** El número de núcleos: el PC le da a LobbyLink 4 y la t3.small 1, y su techo con el código original es 3 veces mayor, 71 contra 23,3 req/s. No llega a 4 veces porque en Windows nativo cada petición cuesta más: el login cuesta 112,1 ms en Windows y 56,0 ms en el contenedor sobre el mismo chip. El contador de frecuencia por hilo lo explica: durante el login los hilos de la app corren a 2.126 MHz ponderados (`20261110_045149_windows_v3frec-f1-login`), contra 4,63 GHz en el contenedor; la razón 2,18 es del orden de la razón de latencias, 1,87. No medimos qué baja el reloj.

**¿Qué le sobra y qué le falta?** Le sobran CPU, RAM y disco: con el código corregido a 80 req/s ocupa el 5 % de sus 8 hilos. Le faltan las condiciones de un servidor: es un portátil con Windows, sin IP pública ni respaldo de energía o de disco.

**¿Cuánto cuesta?** 129.000-134.000 COP al mes, 39,84-41,39 USD con la TRM del 2026-11-08. Es una estimación: depreciación de 4.000.000 COP en 36 meses más la energía de 35 W de TDP a 700-900 COP/kWh.

**¿Qué se rompe con la carga por diez?** Con el código original, la CPU: a 100 req/s `mongod` llega a 568 % y la app a 192 %, el 95 % de los 8 hilos, y vence el tiempo límite el 100 % de las peticiones. Con el código corregido no se rompe nada: a 100 req/s ocupa el 6,5 % de los hilos, y con 20.000 lobbies pasa con p95 de 335,7 ms porque la JVM ve 16 GB y la app llega a 1.938 MB residentes.

### Contenedor

**¿Aguanta la carga?** Con el código original aguanta 10 req/s, con p95 de 408 a 478 ms, y falla en 20. Con el código corregido pasa toda la escala, y en la rampa llega a 314,3 req/s.

**¿Dónde espera?** En la cuota de CPU. Con el código original limita la de `mongod`: con 1 CPU cada uno, el reparto de cuotas (F4) da 18,0 req/s; darle 4 CPU a la app lo deja en 17,8, y darle 2 a `mongod` lo sube a 26,9. Cuando la cuota limita, el frenado llega a 3.951-5.160 ms por segundo. Con el código corregido limita la cuota de la app y el máximo sube a 410 req/s. El disco hace 0 IOPS en promedio.

**¿Qué componente lo causa?** La cuota CFS de 1 CPU. El Ryzen es más rápido por hilo, pero un listado original cuesta casi lo mismo que en la t3.small, 169,8 contra 167,4 ms, porque cada una de las ~406 consultas cruza la red virtual de Docker y el kernel gasta tanto como el código: `sy` 5,2 % contra `us` 5,0 %. El segundo límite es el heap de unos 256 MB que la JVM toma al ver 1 GB. Con el tráfico por diez se llenó (243 de 247 MB) y la app pasó el 19,5 % del tiempo en recolecciones completas. Con `-Xmx700m` ya no hubo `OutOfMemoryError`, pero a 100 req/s siguió fallando el 100 % con `mongod` al 101 % de su cuota: el heap era un riesgo, pero la falla es la CPU de `mongod`.

**¿Qué le sobra y qué le falta?** Le sobran disco y memoria del contenedor: la app usa 219 MB de su GB. Le falta heap cuando se forma cola o crecen los datos, y, como corre sobre el PC, las condiciones de un servidor.

**¿Cuánto cuesta?** La sexta parte del PC, porque sus cuotas son 2 de 12 hilos: 21.500-22.400 COP al mes, 6,64-6,92 USD.

**¿Qué se rompe con la carga por diez?** Con el código original cede primero el heap y después la CPU: la app llega al 97 % de su cuota y falla el 100 %; con 2.000 lobbies las recolecciones completas ocupan el 77,3 % del tiempo. Con el código corregido la app usa el 33 % de su cuota a 100 req/s. Con 20.000 lobbies falla el 100 % aunque la predicción decía 27 % de CPU: el heap de 247 MB no alcanza (1.782 pausas Full GC y 178 `OutOfMemoryError`).

### EC2 t3.small

**¿Aguanta la carga?** En Unlimited con el código original aguanta 10 req/s, con p95 de 393 a 408 ms; en 20 req/s vence el tiempo límite el 88,9 % de las peticiones. Con el código corregido pasa toda la escala con p95 de 12 a 16 ms y 0 errores en tres repeticiones, y la rampa llega a 267,6 req/s. En Standard sin créditos, el código original solo pasa 2 req/s.

**¿Dónde espera?** En la CPU: a 10 req/s con el código original, `us` 39,9 % con `wa` 0,0 %, y `mongod` usa 62 % de un núcleo contra 34 % de la app. Con un solo cliente el p50 del listado es 153,2 ms y su CPU 167,4 ms: la petición pasa casi todo su tiempo ejecutando consultas. El disco hace 1 IOPS, el 0,28 % de las 354 escrituras con `fsync` que soporta. En Standard sin créditos la espera aparece como `steal`: 78,8 % de `steal` y 16,8 % de `us` a 10 req/s.

**¿Qué componente lo causa?** El único núcleo físico. En la prueba de paralelismo (F3) deja de rendir más con 2 clientes, mientras el PC sigue hasta 8. Con el mismo código, la fracción paralela sale p = 0,743 en el listado y 0,828 en el login, contra 0,981 y 0,945 en el PC. Si la parte secuencial fuera del código saldría igual en las dos máquinas: ese 26 % "secuencial" es el núcleo compartido, porque el segundo cliente recibe el segundo hilo del mismo núcleo, que aporta +59 % en el listado y +71 % en el login en lugar de +100 %. Ese núcleo es además más lento por hilo: el login cuesta 83,1 ms en el Xeon y 56,0 ms en el Ryzen, 1,48 veces, y la frecuencia medida da 4,63 / 3,07 = 1,51. La memoria no es la causa: si cada uno de los ~40.800 documentos que examina un listado fuera un fallo a RAM de 118 ns, sumarían 4,8 ms de 167,4, un 2,9 %.

**¿Qué le sobra y qué le falta?** Le sobran disco y red, y mientras el nivel pasa también memoria: usa 449 de 1.905 MB, y en los 40 minutos de la prueba de larga duración (F8) el RSS de la app sube de 310 a 324 MB, sin señal de fuga. Le falta CPU: un solo núcleo racionado con créditos.

El disco sobra incluso cuando los datos no caben en memoria. En la prueba de datos fuera de memoria (F9), con 1.000.000 de lobbies (3.117 MB contra 440 MB de caché), los fallos de caché subieron de 0 % a 12-14 % y a 400 req/s el disco hizo 365 IOPS, con `wa` 3,4 %: el 12 % de sus 3.049 IOPS. El p95 subió de 28 a 121 ms, pero todos los niveles pasaron, y la CPU llegó al 72 % con y sin la base en caché.

**¿Cuánto cuesta?** La instancia son 15,18 USD al mes (730 h × 0,0208) y el EBS 1,60 USD: 16,78 USD de base, más los créditos medidos en CloudWatch. Con el código original a 10 req/s los créditos suman 19,13 USD y el total es 35,91 USD: cuestan más que la instancia. Con el código corregido no paga créditos hasta 40 req/s, porque la CPU queda en 14,9 %, bajo la línea base; a 80 req/s paga 4,48 USD y el total es 21,26 USD.

**¿Qué se rompe con la carga por diez?** Con el código original, la CPU: a 100 req/s llega a 99,9 % y falla el 100 %, como predijo el modelo con 429 % de las 2 vCPU. Con el código corregido queda en 34 %, contra 30 % predicho. Con cien veces los datos, 20.000 lobbies, se rompe la memoria y no la CPU: la predicción era 37 % de CPU, pero falló el 100 %. Con el heap por defecto de 478 MB hubo 95 pausas Full GC y `OutOfMemoryError`; con `-Xmx1g` el kernel mató a Java a los 30 s, con 949 MB residentes y `mongod` ocupando unos 580 MB de los 1,9 GiB.

## 4. Respuestas para la aplicación

**¿Dónde espera LobbyLink?** En la CPU, en las tres máquinas y con las dos versiones del código. La prueba más limpia es la t3.small original a 10 req/s: `us` 39,9 %, `wa` 0,0 %, 1 IOPS y 0,03 % de la red. `mongod` gasta entre el 58 y el 75 % del costo del listado. El disco solo aparece cuando los datos no caben en la caché (prueba F9), y aun así la CPU se llena primero.

**¿Por qué ese número y no otro?** Porque sale de U = λ·D con D medido en la prueba de costo por petición (F1), y la rampa hasta el techo (F5) midió una utilización a entre 1 y 8 puntos de la predicha. Antes del techo falla la latencia: con el código original un listado ocupa la CPU 150-210 ms, basta una cola de unas 5 peticiones para pasar de 1 s y el codo cae al 50-62 % del techo; con 7 ms por listado el codo sube al 80-90 %. El modelo no ve la memoria, y por eso no predijo la falla con 20.000 lobbies.

**¿Qué componente causa cada número?** Los núcleos explican el techo (4 contra 1); la parte secuencial del código es pequeña (1,9 % y 5,5 %), así que LobbyLink aprovecharía más núcleos. La frecuencia por hilo explica el costo de BCrypt entre máquinas. El SMT explica que la t3.small llegue a su máximo con 2 clientes y su p más baja. La cuota CFS y el heap derivado del límite de memoria explican el contenedor; la línea base del hipervisor, el `steal` de Standard; y la caché de WiredTiger, que el disco no importe.

**Si la carga se multiplicara por diez, ¿qué se rompería primero?** Con el código original, la CPU, por el listado con N+1, en las tres máquinas y en los dos escenarios. La predicción escrita antes de medir daba 141 % de los hilos del PC, 499 % de la cuota de `mongod` en el contenedor y 429 % de las vCPU de la t3.small. El listado examina N² documentos, y con 2.000 lobbies esa parte ya es el 42-67 % de la CPU de `mongod`. Con el código corregido no se rompe nada a diez veces. A cien veces los datos se rompe la memoria de la JVM donde el heap por defecto es pequeño (contenedor y t3.small).

**¿Qué opción descartamos y por qué?**

- **t3.small Standard.** Sin créditos atiende 2 req/s con el código original, y con el corregido cae a la línea base por encima de 58-67 req/s. Unlimited cuesta lo mismo hasta 40 req/s sin ese riesgo.
- **PC.** Tiene la mayor capacidad medida, pero no es un servidor y su costo depende de supuestos. Su equivalente en AWS, una c7a.2xlarge, cuesta 301,31 USD al mes, 18 veces la t3.small, para una capacidad que LobbyLink corregido no necesita.
- **Contenedor.** Pasa la misma carga que la t3.small, pero corre sobre el PC con sus carencias, y con 20.000 lobbies falla por heap.

**Recomendación.** LobbyLink con el arreglo del N+1 en una EC2 t3.small Unlimited con 20 GiB de EBS gp3: 16,78 USD al mes hasta 40 req/s y 21,26 USD a 80 req/s. A 80 req/s la CPU queda en 28,8 %, bajo la regla del 60 %, con p95 de 16 ms y 0 errores en tres repeticiones; con el tráfico por diez usa el 34 %. Vale mientras la base tenga pocos miles de lobbies abiertos. Con el código original sería la misma instancia, pero solo hasta 10 req/s y por 35,91 USD al mes.

## 5. Cambios y mejoras visibles

El arreglo, en `LobbyLink_backend_nplus1/`, cambia solo `LobbyServiceImpl`: cuenta los participantes de todos los lobbies con una sola agregación y busca todos los videojuegos a la vez con `findAllById`. No agrega índices ni cambia el modelo de datos, y 95 respuestas comparadas entre las dos versiones fueron idénticas campo por campo (`telemetry/comparar_respuestas.mjs`).

- **Costo del listado.** Bajó de 220,3 a 7,2 ms de CPU en el PC, de 169,8 a 6,9 en el contenedor y de 167,4 a 7,1 en la t3.small, entre 24 y 31 veces menos. Los documentos examinados por petición bajaron de 20.412 a 602.
- **Techo.** El predicho subió de 71 a 1.288,9 req/s en el PC, de 20 a 262,3 en el contenedor y de 23,3 a 336,5 en la t3.small.
- **Carga sostenida.** El mayor nivel que pasan las tres subió de 10 a 80 req/s, y el p95 bajó de 393-478 ms a 12-23 ms.
- **Crecimiento con los datos.** El exponente bajó de 1,10-1,21 a 0,50-0,64. Con 1.600 lobbies un listado pasó de 2,1-2,4 s a 22-29 ms de CPU.
- **Carga por diez.** Las tres máquinas pasaron de fallar a pasar con 0 errores, en tráfico y en datos.
- **Costo.** En la t3.small a 10 req/s los créditos bajaron de 19,13 USD al mes a 0, y el total de 35,91 a 16,78 USD.
- **Quién limita.** Antes, `mongod`; ahora la app, que en la t3.small gasta 3,6 ms por petición contra 2,3 de `mongod`.

Pasar de la t3.small al PC multiplica por 3 el techo del código original; corregir el código en la misma t3.small lo multiplica por 14.

## 6. Dónde falla ahora y qué falta decir

**Dónde se rompe ahora.** Con el código corregido ningún nivel de la carga sostenida (F6) ni de la carga por diez (F7) falla. El límite sigue siendo la CPU, pero a tasas entre 27 y 52 veces mayores: el último nivel de la rampa que pasa es 267,6 req/s en la t3.small, 314,3 en el contenedor y 1.034 en el PC. La t3.small Standard llega antes, a 58-67 req/s, cuando se le acaban los créditos. Con 20.000 lobbies fallan por memoria la t3.small y el contenedor.

**Lo que el arreglo no resolvió.**

- El listado sigue sin paginación: con 2.000 lobbies el p95 es el doble que con 200, y con 20.000 la respuesta no cabe en el heap. Paginar `GET /api/lobbies` es el siguiente arreglo y no lo medimos.
- `participaciones.lobbyId` sigue sin índice y el costo crece con exponente 0,50-0,64.
- El login no cambió: BCrypt cuesta 83,6 ms de CPU en la t3.small, que dan como máximo unos 24 logins por segundo. `mezcla-lectura` no tiene logins, por eso ese límite no aparece en la carga sostenida.
- En una máquina chica hay que fijar el heap con `-Xmx` en proporción a la memoria, sin quitarle la suya a `mongod`.

**Lo que falta medir o decir.**

- Las mezclas salen de la colección Postman, no de uso real.
- En el PC y el contenedor el generador corre en el mismo equipo, Docker corre sobre WSL2 y las versiones de MongoDB y Java difieren entre el PC y las otras dos opciones.
- Las explicaciones de SMT, frecuencia y memoria salen de microbenchmarks y del contador de frecuencia de Windows, no de contadores de hardware.
- La carga sostenida con el código corregido tiene 2 repeticiones en el PC y el contenedor, y la de datos por diez y por cien una por tamaño. El resto de cautelas está en el capítulo 12 del anexo.

## Datos crudos y guiones

- **Aplicación:** `LobbyLink_backend/` (jar `jars/disenofinal-base.jar`) y la versión corregida `LobbyLink_backend_nplus1/` (`jars/disenofinal-nplus1-fix.jar`).
- **Datos crudos:** `lobbylink_perfv3/resultados/`, una carpeta por corrida; tablas del modelo y créditos en `resultados/_logs/`; precios de AWS en `resultados/_aws_*`.
- **Guiones:** `campanas/campana.sh`, `campanas/campana_jar.sh`, `campanas/pendientes_local.sh` y `telemetry/` (`rate.mjs`, `load.mjs`, `agent.mjs`, `model.mjs`, `report.mjs`).
- **Visor:** `dashboard/index.html`.
- **Índice y comandos:** anexos A y B de `anexo_tecnico.md`.
