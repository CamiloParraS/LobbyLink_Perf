# LobbyLink: en qué máquina debe correr

Arquitectura Computacional, UCC, proyecto final. Todas las cifras salen de nuestras corridas en `lobbylink_perfv3/resultados/`. El detalle de cada fase, las tablas completas y la ruta de cada carpeta cruda están en `anexo_tecnico.md` ("anexo, cap. X").

## 1. Introducción

### Qué hicimos

El enunciado pregunta en qué máquina debería correr una aplicación real y con qué datos se sostiene esa decisión. Tomamos LobbyLink, le generamos carga sostenida de forma repetible y la medimos en tres opciones: el PC de un integrante, un contenedor Docker con límites que fijamos nosotros y una instancia EC2 t3.small de AWS. En cada una medimos CPU (promedio, pico y por núcleo), memoria residente, IOPS y MB/s de disco, red de entrada y salida, y latencia p50, p95 y p99.

Al medir encontramos que el costo de la aplicación se concentra en un solo endpoint, por un defecto del código (consultas N+1). Lo corregimos sin tocar la base de datos y repetimos todas las mediciones con el código corregido. Así el informe compara las tres máquinas dos veces, con el código original y con el corregido, y muestra qué pesa más en la decisión.

### El repositorio

LobbyLink es el backend de una aplicación para organizar partidas: un usuario publica un lobby para un videojuego y otros se unen hasta llenarlo. Lo escribió Jeferson Morillo para Diseño de Software. Lo elegimos porque arranca en nuestras máquinas solo con MongoDB y podemos cargarlo sin depender de nadie.

El trabajo está repartido en cuatro carpetas:

- `LobbyLink_backend/` es la aplicación original. Es una API REST en Spring Boot 3.5.14 con 23 endpoints en 7 controladores, capas `controller` → `service` → `repository` y MongoDB con Spring Data. La autenticación es JWT sin estado y las contraseñas se guardan con BCrypt de factor 10. Trae una colección Postman con el recorrido de uso que documenta el proyecto.
- `LobbyLink_backend_nplus1/` es nuestra copia con el arreglo del listado (sección 6). Su jar es `jars/disenofinal-nplus1-fix.jar`; el original es `jars/disenofinal-base.jar`. Medimos los dos con el mismo protocolo y cambiamos solo el jar.
- `lobbylink_perfv3/telemetry/` tiene las herramientas de medición: `rate.mjs` (generador a tasa fija), `load.mjs` (generador de bucle cerrado), `agent.mjs` (agente de telemetría que corre fuera de la app), `model.mjs` (modelo de capacidad) y `report.mjs` (tablas). `campanas/campana.sh` corre todas las fases en las tres opciones.
- `lobbylink_perfv3/resultados/` guarda una carpeta por corrida con el registro del generador (`load.ndjson`), el del agente (`agent.ndjson`), el log de la app, la configuración (`run.json`) y el reposo previo (`idle.json`). Ninguna corrida sobrescribe otra.

Al leer el código vimos dónde está el costo. `GET /api/lobbies` (`LobbyServiceImpl.listLobbies`) devuelve todos los lobbies abiertos sin paginar, y por cada uno hace dos consultas más: cuenta sus participantes (`countByLobbyId`) y busca su videojuego (`findById`). Con 200 lobbies son unas 406 consultas por petición, y `participaciones.lobbyId` no tiene índice. El otro punto caro es login y registro, porque BCrypt hace 2¹⁰ rondas de cálculo dentro de la JVM.

### Las cargas preparadas

Cada corrida crea una base nueva con 1 videojuego, 20 usuarios y 200 lobbies de un participante. Empezamos siempre de cero porque el listado recorre todos los lobbies, y con una base acumulada cada corrida mediría otra aplicación. Los 200 lobbies son un tamaño que elegimos nosotros, así que también medimos de 100 a 2.000.

**Cómo llegan las peticiones.** Para la carga sostenida usamos `rate.mjs`, que manda peticiones a una tasa fija λ (en peticiones por segundo, req/s), contesten o no. Las llegadas siguen un proceso de Poisson con semilla fija: al azar, con promedio λ y siempre la misma secuencia para la misma semilla. Es como llegan los usuarios de una API, que no esperan a que el servidor termine con los demás. La latencia se mide desde la hora en que cada petición debía salir, así que si el servidor se atasca, el atasco queda en la medición. Una petición que tarda más de 10 s cuenta como error. Si el propio generador se atrasa más de 50 ms en p99, el nivel no cuenta.

**Qué peticiones se mandan.** Hay dos mezclas, las dos sacadas de la colección Postman del proyecto:

- `mezcla-lectura`: 50 % listar lobbies (`GET /api/lobbies`) y 50 % ver un lobby (`GET /api/lobbies/{id}`). No crea datos, así que la carga es la misma del primer al último segundo. Es la que usamos para comparar las máquinas.
- `mezcla-postman`: los seis endpoints de la colección en partes iguales, un sexto cada uno (registro, login, crear lobby, listar, ver y unirse). Como crea un lobby cada seis peticiones, el listado se encarece durante la corrida. La usamos solo para validar el modelo en la rampa.

**Cuánto y cuánto tiempo.** Las tasas no son supuestas: salen de una cadena de fases en la que cada una usa lo que midió la anterior.

- **F0, techo del hardware.** Sin la app: `fio` mide el disco durante 60 s por prueba (lectura aleatoria de 4 KiB, escritura con `fsync`, lectura secuencial de 1 MiB) e `iperf3` mide la red durante 30 s.
- **F1, costo por petición.** Un solo cliente durante 120 s, con 20 s de calentamiento, en cada uno de los seis endpoints por separado. Da D, los milisegundos de CPU que cuesta una petición, separados en la app y `mongod`.
- **F2, crecimiento con los datos.** Un cliente que solo lista, 90 s por tamaño, con 100, 200, 400, 800 y 1.600 lobbies.
- **F3 y F4, paralelismo y cuotas.** Bucle cerrado de 60 s por nivel: de 1 cliente hasta el doble de los hilos en F3, y en el contenedor seis combinaciones de cuota (de 0,5 a 4 CPU) con 1, 4 y 16 clientes en F4.
- **F5, rampa.** Tasa fija del 10 % al 150 % del techo que predice el modelo, en pasos de 10 %, 90 s por nivel.
- **F6, carga sostenida y comparación.** La misma escala en las tres opciones: 5, 10, 20, 40 y 80 req/s, 600 s por nivel (10 minutos), 30 s de calentamiento y 60 s de pausa entre niveles, con tres repeticiones de semillas 1, 2 y 3. Cada repetición completa de F6 dura unos 58 minutos por opción. Con el jar corregido, el PC siguió con 160 y 320 req/s.
- **F7, carga ×10.** 100 req/s con 200 lobbies (tráfico ×10) y 10 req/s con 2.000 lobbies (datos ×10), 600 s cada uno. La predicción del tráfico ×10 quedó escrita en un archivo antes de medir.
- **F8, larga duración.** 10 req/s durante 40 minutos en la t3.small Unlimited y 23 req/s durante 90 minutos en la Standard, para ver créditos de CPU y crecimiento de memoria.

**Cuándo pasa un nivel.** Pasa si el p95 es ≤ 1.000 ms y los errores ≤ 1 % (`telemetry/profiles/umbrales.json`). El límite de 1.000 ms lo declaramos nosotros. Con el jar corregido ningún nivel cambia de resultado si el límite es 300 o 500 ms. Para recomendar una opción a una tasa pedimos además que su recurso más ocupado quede, en promedio, a ≤ 60 % de su capacidad, y dejamos el resto como margen.

**Qué mide el agente.** `agent.mjs` toma una muestra por segundo (cada 2 s en Windows) de la CPU de la máquina (`us`, `sy`, `wa`, `steal`) y de cada proceso, el RSS, las IOPS y MB/s de disco, los bytes de red, el frenado de la cuota en Docker, y de `mongod` las consultas, los documentos examinados y los fallos de caché de WiredTiger. `report.mjs` cruza esas muestras con la ventana de medición de cada nivel y deja fuera el calentamiento.

## 2. Entornos

### PC: máquina física

Es un portátil con un **AMD Ryzen 7 7445HS** (microarquitectura Zen 4, de 2023, con TDP de 35 W). Tiene **6 núcleos y 12 hilos**, 3,2 GHz de base y turbo de hasta 4,7 GHz según la ficha de AMD. Medimos la frecuencia con nuestro microbenchmark (`resultados/_microbench_ryzen_20261108/`): el núcleo 0 sostiene 4,7 GHz, pero un hilo fijado en los núcleos 1 a 3 se queda en 3,15 GHz bajo Windows. La caché es de 64 KB de L1 y 1 MB de L2 por núcleo (6 MB en total) y 16 MB de L3 compartida. Medimos la latencia de acceso: 0,85 ns en L1, 2,96 ns en L2, 10,7 a 14,8 ns en L3 y 85,7 a 112,9 ns en RAM.

Tiene **15,2 GB de RAM** y un **SSD NVMe de 512 GB**. El disco da 41.903 IOPS en lectura aleatoria de 4 KiB (375 µs en p50), 1.488 IOPS de escritura con `fsync` y 1.306,8 MB/s en lectura secuencial. Corre Windows 11 Home, Oracle Java 25 y MongoDB 9.0.4, con una caché de WiredTiger de 7.287 MB.

LobbyLink no usa todo el equipo. `run.mjs` fija la app y `mongod` en los hilos 0 a 7, que son 4 núcleos físicos con SMT, y el generador en los hilos 8 a 11. El generador corre en la misma máquina, así que no hay red de por medio (loopback).

### Contenedor `a1m1`: límites nuestros

Corre en el mismo Ryzen, dentro de Docker Desktop 29.8.2 sobre la VM Linux de WSL2, que ve 12 CPU y 7,4 GB. El límite lo ponemos nosotros en `envs/compose.yml`: **1 CPU y 1 GB para la app, y otro contenedor con 1 CPU y 1 GB para `mongod`**. La CPU se limita con una cuota del planificador CFS (`cpu.max = 100000 100000`): el kernel le da al contenedor 100 ms de CPU por cada periodo de 100 ms, y si los gasta antes lo detiene hasta el siguiente periodo. A esa detención la llamamos frenado (`throttled`). La cuota limita tiempo, no núcleos: el contenedor puede correr en cualquiera de las 12 CPU, pero en total no pasa de 1. Dentro del contenedor el microbenchmark da 4,63 GHz en cualquier vCPU, más que los 3,15 GHz que Windows nativo da fuera del núcleo 0.

El disco es un archivo virtual de la VM, guardado en el mismo NVMe. Da 79.766 IOPS en lectura aleatoria (una cota superior, porque Windows puede servir parte de esas lecturas desde su caché), 1.155 IOPS con `fsync` y 1.410,6 MB/s secuenciales. El software es Eclipse Temurin 21.0.12 y MongoDB 7.0.45. Como `mongod` solo ve 1 GB, su caché de WiredTiger queda en el mínimo de 256 MB. La JVM también dimensiona su heap con ese GB: toma un cuarto, unos 256 MB, y con 1 CPU visible elige Serial GC.

### EC2 t3.small: nube

Es una instancia de AWS en us-east-1c con un **Intel Xeon Platinum 8259CL** (Cascade Lake, de 2019), de 2,5 GHz nominales y turbo sostenido de hasta 3,1 GHz según la ficha de T3. Medimos 3,07 GHz con un hilo y 2,82 GHz por hilo con los dos ocupados. Tiene **2 vCPU, que son los dos hilos de un solo núcleo físico**: comparten 64 KB de L1 y 1 MB de L2. La L3 de 35,75 MB es del chip entero y la comparten otros clientes del servidor. Medimos 1,62 ns en L1, 4,54 ns en L2, 24,7 a 29,9 ns en L3 hasta unos 4 MB, y 100,9 a 118,1 ns en RAM desde 8 MB. Es decir, el L3 que efectivamente le toca es mucho menor que el de la ficha.

Tiene **1,9 GiB de RAM** y un **volumen EBS gp3 de 20 GiB**, que va por la red del centro de datos. El disco se detiene en los límites que AWS le pone al volumen: 3.049 IOPS en lectura aleatoria, con 10 ms por lectura en p50 (27 veces más lento que el NVMe), 354 IOPS con `fsync` y 127,3 MB/s. La red hacia el generador da 4.953 Mbit/s. El generador corre en otra instancia, una c7i-flex.large (2 vCPU, 4 GiB) en la misma red privada. El software es Ubuntu 26.04.1 con kernel 7.0.0-1016-aws, Java 21.0.12 y MongoDB 7.0.45, con caché de WiredTiger de 440 MB.

La t3.small es una instancia de rendimiento variable. Su línea base es el 20 % de cada vCPU y gana 24 créditos de CPU por hora. En modo **Unlimited** puede pasar de esa línea base, y AWS cobra los créditos de más a 0,05 USD por vCPU-hora. En modo **Standard**, cuando se acaban los créditos, el hipervisor la deja en 0,4 vCPU y lo demás aparece en Linux como `steal`. Medimos los dos modos. Cuesta 0,0208 USD/h bajo demanda.

## 3. Resultados

La tabla junta la carga sostenida (F6, `mezcla-lectura`, 600 s por nivel) con los recursos del último nivel que pasan las tres opciones: 10 req/s con el código original y 80 req/s con el corregido (repetición r1). Las latencias en ms. La CPU de proceso está en % de un núcleo.

| | PC original | Contenedor original | t3.small original | PC corregido | Contenedor corregido | t3.small corregido |
| --- | --- | --- | --- | --- | --- | --- |
| Mayor λ que pasa en F6 | 20 req/s (40 en 2 de 3) | 10 req/s | 10 req/s | 80 (y 320) req/s | 80 req/s | 80 req/s |
| p50 / p95 / p99 en el nivel de la tabla | 20,7 / 218 / 245 | 72,7 / 408 / 765 | 22,4 / 393 / 605 | 9,8 / 19,9 / 22,4 | 10,6 / 20,7 / 22,4 | 7,8 / 16,4 / 35,9 |
| CPU de la máquina, promedio / pico | 19,4 % / 76 % | 10,2 % / 17,5 % de la VM | 48,2 % / 99,5 % | 15,7 % / 58 % | 6,6 % / 8,8 % de la VM | 28,8 % / 97,1 % |
| `us` / `wa` / `steal` | 8,9 % / no aplica | 5,0 % / 0,0 % / 0 % | 39,9 % / 0,0 % / 0,5 % | 6,0 % / no aplica | 2,9 % / 0,0 % / 0 % | 23,8 % / 0,0 % / 1,2 % |
| CPU app / `mongod`, promedio | 27 / 77 | 41 / 56 | 34 / 62 | 19 / 22 | 26 / 21 | 33 / 23 |
| RSS app / `mongod` (MB) | 241 / 96 | 217 / 80 | 260 / 189 | 246 / 132 | 219 / 82 | 250 / 162 |
| Disco, IOPS / MB/s | 29 / 1,98 (todo el equipo) | 0 / 0,01 | 1 / 0,01 | 19 / 2,75 (todo el equipo) | 0 / 0,01 | 1 / 0,01 |
| Red de salida (MB/s) | loopback | 0,79 | 0,17 | loopback | 0,90 (a 40 req/s) | 1,39 |
| Documentos examinados por petición | 20.432 | 20.413 | 20.412 | 602 | 602 | 602 |
| Fallos de caché de WiredTiger | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % |
| Tráfico ×10 (100 req/s) | 100 % de errores | 100 % de errores | 100 % de errores | p95 19,9 ms | p95 20,7 ms | p95 16,4 ms |
| Datos ×10 (2.000 lobbies) | 99,18 % de errores | 99,18 % de errores | 99,18 % de errores | p95 45,4 ms | p95 45,4 ms | p95 62,2 ms |
| Costo mensual | 39,84-41,39 USD | 6,64-6,92 USD | 35,91 USD | 39,84-41,39 USD | 6,64-6,92 USD | 21,26 USD |

En el PC el disco es el de todo el equipo, no el de LobbyLink: la app y `mongod` leen 0 MB/s. Cuando un nivel falla, falla entero: a 20 req/s la t3.small original responde entre 1,8 y 2,2 req/s con 89-95 % de errores. El p50 de `mezcla-lectura` salta entre unos 20 y 170 ms según la repetición, porque la mitad de las peticiones son ver (unos 13 ms) y la otra mitad listar (unos 200 ms con el original), y la mediana cae en el borde. Por eso comparamos con p95 y p99.

Para responder por entorno usamos las preguntas del enunciado (si aguanta la carga, dónde espera, qué le sobra, qué le falta, cuánto cuesta) y las de la sustentación (qué componente lo causa, qué se rompe primero con ×10).

### PC

**¿Aguanta la carga?** Con el código original, hasta 20 req/s en las tres repeticiones. A 40 req/s pasa dos veces (p95 de 629 y 827 ms) y falla la tercera, así que 40 no es fiable. Con el corregido pasa toda la escala y también 160 y 320 req/s, con p95 de 17,7 a 19,2 ms.

**¿Dónde espera?** En la CPU, y sobre todo en la de `mongod`. A 10 req/s con el original, `mongod` usa 77 % de un núcleo y la app 27 %. En F3 el listado escala casi sin pérdida entre hilos (fracción paralela p = 0,981) y el máximo es 28,8 req/s con 8 clientes, con `mongod` a 572 % y la app a 153 %: se llenan los 8 hilos que le dimos. El disco de la app y `mongod` está en 0 MB/s, porque los datos caben en la caché de 7.287 MB.

**¿Qué componente lo causa?** El número de núcleos. Le da a LobbyLink 4 núcleos físicos, contra 1 de la t3.small, y por eso su techo original es 3 veces el de la t3.small (71 contra 23,3 req/s). No es 4 veces porque cada petición cuesta más en Windows nativo: el login (BCrypt, cálculo puro) cuesta 112,1 ms en Windows y 56,0 ms en el contenedor sobre el mismo chip. Parte de esa diferencia es la frecuencia: Windows deja un hilo fijado fuera del núcleo 0 en 3,15 GHz en lugar de 4,7 (cociente 1,49, contra 2,0 del login). El resto no lo pudimos explicar.

**¿Qué le sobra y qué le falta?** Le sobran CPU, RAM y disco: con el corregido a 80 req/s ocupa el 5 % de sus 8 hilos. Le falta lo que hace falta para ser un servidor: es un portátil con Windows, sin IP pública ni redundancia de energía o disco.

**¿Cuánto cuesta?** 129.000-134.000 COP al mes (39,84-41,39 USD con la TRM del 2026-11-08), con supuestos nuestros: 4.000.000 COP depreciados en 36 meses y 35 W de TDP a 700-900 COP/kWh. No incluye el plan de internet. La instancia de nube más parecida, una c7a.2xlarge con 8 núcleos Zen 4, cuesta 301,31 USD al mes (sin medir).

**¿Qué se rompe con ×10?** Con el original, la CPU. A 100 req/s `mongod` llega a 568 % y la app a 192 %, el 95 % de los 8 hilos, y el 100 % de las peticiones vence el tiempo límite. Con 2.000 lobbies a 10 req/s responde 0,08 req/s. Con el corregido no se rompe nada: 6,5 % de los hilos a 100 req/s.

### Contenedor

**¿Aguanta la carga?** Con el original, hasta 10 req/s, con p95 de 408 a 478 ms; falla en 20. Con el corregido pasa toda la escala, y en la rampa F5 llega a 314,3 req/s.

**¿Dónde espera?** En la cuota de CPU. Con el original limita la de `mongod`: con 1 CPU para cada uno el máximo es 18,0 req/s, dar 4 CPU a la app no lo cambia (17,8) y dar 2 CPU a `mongod` lo sube a 26,9 (F4). Con el corregido limita la de la app, y el máximo con 1 CPU para `mongod` sube a 410 req/s. Cuando la cuota limita, el frenado llega a 3.951-5.160 ms por segundo: el kernel detiene al contenedor la mayor parte de cada periodo. Disco y red no esperan: 0 IOPS en promedio y 0 % de fallos de caché.

**¿Qué componente lo causa?** Dos límites que pusimos nosotros. Uno es la cuota CFS de 1 CPU. El otro, que no esperábamos, es el heap de la JVM: con 1 GB visible toma unos 256 MB y Serial GC. En el tráfico ×10 el heap se llenó (243 de 247 MB) y la app pasó el 19,5 % del tiempo en recolecciones completas. Además, aunque el Ryzen es más rápido por hilo, un listado original cuesta casi lo mismo que en la t3.small (169,8 contra 167,4 ms), porque cada una de las ~406 consultas cruza la red virtual de Docker y el kernel gasta tanto como el código (`sy` 5,2 % contra `us` 5,0 %).

**¿Qué le sobra y qué le falta?** Le sobran memoria del contenedor (219 MB de RSS de 1 GB) y disco. Le falta heap cuando hay cola, y le falta lo mismo que al PC, porque corre sobre él.

**¿Cuánto cuesta?** La sexta parte del PC, porque sus cuotas son 2 de los 12 hilos: 21.500-22.400 COP, es decir 6,64-6,92 USD al mes. En AWS lo más parecido es una c7a.large (2 núcleos Zen 4, 4 GiB) por 76,53 USD al mes, sin medir.

**¿Qué se rompe con ×10?** Con el original, primero la memoria de la JVM y luego la CPU: la app al 97 % de su cuota con `mongod` al 53 %, el heap lleno y 100 % de errores. Con 2.000 lobbies el GC completo ocupa el 77,3 % del tiempo. Con el corregido, la app usa 33 % de su cuota a 100 req/s y el p95 es 20,7 ms.

### EC2 t3.small

**¿Aguanta la carga?** En Unlimited, con el original, hasta 10 req/s (p95 de 393 a 408 ms), y falla en 20 con 88,9 % de peticiones vencidas. Con el corregido pasa toda la escala, con p95 de 12 a 16 ms y 0 errores en las tres repeticiones; en la rampa llega a 267,6 req/s. En Standard sin créditos, el original solo pasa 2 req/s.

**¿Dónde espera?** En la CPU. A 10 req/s con el original, `us` es 39,9 % con `wa` 0,0 %, y `mongod` usa 62 % de un núcleo contra 34 % de la app. Con un cliente, el p50 del listado (153,2 ms) es casi igual a su CPU (167,4 ms): la petición pasa su tiempo ejecutando consultas. El disco hace 1 IOPS en promedio, el 0,28 % de las 354 escrituras con `fsync` que soporta, y son las escrituras del journal de WiredTiger. La red de salida es 1,39 MB/s a 80 req/s, el 0,22 % de lo que midió `iperf3`. En Standard sin créditos, la espera aparece como `steal`: 78,8 % con `us` 16,8 % a 10 req/s.

**¿Qué componente lo causa?** Que sea un solo núcleo físico. En F3 la t3.small deja de rendir más con 2 clientes, porque sus dos vCPU comparten el núcleo, mientras el PC sigue subiendo hasta 8. Ese núcleo además es más lento por hilo: el login cuesta 83,1 ms en el Xeon contra 56,0 ms en el Ryzen con el mismo Java y MongoDB (1,48 veces), y la frecuencia medida explica casi todo (4,63 / 3,07 = 1,51). La memoria no es la causa: si cada uno de los ~40.800 documentos que examina un listado fuera un fallo a RAM de 118 ns, serían 4,8 ms de los 167,4 ms de CPU, un 2,9 %. Encima del núcleo está la línea base del 20 %: el hipervisor la impone en Standard, y en Unlimited cobra lo que pase de ella.

**¿Qué le sobra y qué le falta?** Le sobran disco y red, y memoria mientras el nivel pasa: usa 449 de 1.905 MB, con 0,42 % del tiempo en pausas del GC. En los 40 minutos de F8 el RSS de la app sube de 310 a 324 MB, sin señal de fuga. Le falta CPU: un núcleo, racionado por créditos.

**¿Cuánto cuesta?** 15,18 USD de instancia (730 h × 0,0208) más 1,60 USD de EBS, es decir 16,78 USD al mes, más los créditos medidos en CloudWatch. Con el original a 10 req/s los créditos suman 19,13 USD y el total es 35,91 USD: los créditos cuestan más que la instancia. Con el corregido no cobra créditos a 40 req/s (CPU 14,9 %, bajo la línea base) y cobra 4,48 USD a 80 req/s (21,26 USD en total). Si los clientes están en internet y la carga dura todo el mes, la transferencia de salida (0,09 USD/GB tras 100 GB gratis) sube el total a 47,81 USD a 10 req/s, 167,80 a 40 y 334,74 a 80.

**¿Qué se rompe con ×10?** Con el original, la CPU: 99,9 % a 100 req/s y 100 % de errores, como predijo el modelo (429 % de las 2 vCPU). Con el corregido, 34 % de CPU a 100 req/s (predicho 30 %) y p95 de 62,2 ms con 2.000 lobbies.

## 4. Respuestas para la aplicación

**¿Dónde espera LobbyLink: CPU, disco o red?** En la CPU, en las tres opciones y con los dos jars. La prueba más limpia es la t3.small original a 10 req/s: `us` 39,9 % con `wa` 0,0 %, 1 IOPS de disco y 0,03 % de la red disponible. La mayor parte de esa CPU (58 a 75 % del costo del listado) la gasta `mongod`, no Java, porque cada listado hace unas 206 `find` y 200 conteos. El disco no participa porque los datos ocupan unos 10 MB y caben enteros en la caché de WiredTiger (0 % de fallos en las tres opciones).

**¿Por qué ese número y no otro?** Porque la capacidad sale de la ley de utilización: U = λ · D. En F1 medimos D con un cliente (CPU usada menos la de reposo, dividida entre las peticiones) y el modelo predice el techo como capacidad / D. La utilización medida en la rampa siguió a la predicha con 1 a 8 puntos de diferencia. Lo que falla antes del techo es la latencia: con el original, un listado ocupa la CPU 150-210 ms y bastan unas 5 peticiones en cola para pasar de 1 s, así que el codo cae al 50-62 % del techo. Con 7 ms por listado hacen falta unas 140, y el codo sube al 80-90 %.

**¿Qué componente causa cada número?** Los núcleos del procesador explican el techo: el PC tiene 4 núcleos para LobbyLink y la t3.small uno. La frecuencia por hilo explica el costo de BCrypt (1,48 veces más en el Xeon, frecuencia medida 1,51 veces menor). El SMT explica que la t3.small tope con 2 clientes; el segundo hilo aporta +84 % en login en el PC y +71 % en la t3.small. La cuota CFS explica el frenado del contenedor, y el límite de memoria visible explica su heap de 256 MB. La línea base del hipervisor explica el `steal` de 78,8 % en Standard. La RAM y la caché de WiredTiger explican que el disco no importe.

**Si la carga se multiplicara por diez, ¿qué se rompería primero?** Con el código original, la CPU, por el listado con N+1, en las tres opciones y en los dos escenarios. El modelo lo predijo antes de medir (141 % de los hilos del PC, 499 % de la cuota de `mongod` en el contenedor, 429 % en la t3.small). Con diez veces más datos el daño es el mismo: 99,18 % de errores, porque el listado examina N² documentos y con 2.000 lobbies esa parte cuadrática ya es el 42-67 % de la CPU de `mongod`. En el contenedor, antes que la CPU cede el heap de la JVM. Con el código corregido no se rompe nada en ninguna opción.

**¿Qué opción descartamos y por qué?**

- **t3.small Standard.** Sin créditos atiende 2 req/s con el original. Con el corregido, gastar y ganar créditos se igualan entre 58 y 67 req/s, y por encima de eso caería a la línea base. Unlimited cuesta lo mismo hasta 40 req/s, sin ese riesgo.
- **PC.** Es la opción con más capacidad medida, pero no es un servidor, y su costo depende de supuestos. No lo descartamos por precio: con transferencia, la t3.small cuesta más que el PC desde unos 8 req/s sostenidos.
- **Contenedor.** Pasa la misma carga que la t3.small, pero corre sobre el PC y hereda lo que le falta. Para usarlo en un servidor habría que fijar el heap con `-Xmx` en proporción a su límite.
- **c7a.2xlarge.** Es lo más parecido al PC en AWS, pero cuesta 301,31 USD al mes, 18 veces la t3.small, y LobbyLink corregido no necesita esa capacidad.

**Recomendación.** Desplegar LobbyLink con el arreglo del N+1 en una EC2 t3.small en modo Unlimited con 20 GiB de EBS gp3. Cuesta 16,78 USD al mes de infraestructura hasta 40 req/s y 21,26 USD a 80 req/s. A 80 req/s la CPU queda en 28,8 %, bajo la regla del 60 %, con p95 de 16 ms y 0 errores en 3 repeticiones, y atiende el tráfico ×10 con 34 % de CPU. Si hubiera que desplegar el código original, la recomendación sería la misma instancia solo hasta 10 req/s, por 35,91 USD al mes, y ninguna opción resistiría ×10.

## 5. Cambios y mejoras visibles

El arreglo (`LobbyLink_backend_nplus1/`) cambia solo `LobbyServiceImpl`. En lugar de un conteo por lobby, cuenta los participantes de todos los lobbies con una agregación. En lugar de buscar el videojuego de cada lobby, los busca todos a la vez con `findAllById`. No agrega índices, no cambia el modelo de datos y la respuesta de la API es la misma.

Estas son las mejoras que se vieron en las mediciones:

- **Costo del listado.** Bajó de 220,3 a 7,2 ms de CPU en el PC, de 169,8 a 6,9 en el contenedor y de 167,4 a 7,1 en la t3.small: entre 24 y 31 veces menos. Los documentos examinados por petición bajaron de 20.412 a 602, y las operaciones de `mongod` en la t3.small a 10 req/s, de 1.998 a 54 por segundo.
- **Techo predicho.** Subió de 71 a 1.288,9 req/s en el PC, de 20 a 262,3 en el contenedor y de 23,3 a 336,5 en la t3.small.
- **Carga sostenida.** El mayor nivel que pasan las tres opciones subió de 10 a 80 req/s, el máximo de la escala, y el p95 bajó de 393-478 ms a 12-23 ms.
- **Crecimiento con los datos.** El exponente del costo del listado contra el número de lobbies bajó de 1,10-1,21 a 0,50-0,64. Con 1.600 lobbies, un listado pasó de 2,1-2,4 s a 22-29 ms de CPU.
- **Carga ×10.** Pasó de colapsar en las tres opciones a pasar con 0 errores, tanto con tráfico ×10 como con datos ×10.
- **Costo en la nube.** Los créditos de la t3.small a 10 req/s bajaron de 19,13 USD al mes a 0, y la infraestructura de 35,91 a 16,78 USD.
- **Qué limita.** Con el original limita `mongod`. Con el corregido, la app gasta algo más que `mongod` (3,6 contra 2,3 ms por petición en la t3.small), y en el contenedor la cuota de la app es la que se llena primero.

La mejora más grande no vino de cambiar de máquina. Pasar de la t3.small al PC multiplica el techo del código original por 3. Corregir el código en la misma t3.small lo multiplica por 14.

## 6. Dónde falla ahora y qué falta decir

Con el código corregido, ningún nivel de F6 ni de F7 falla en ninguna opción. Pero la aplicación sigue teniendo un límite, y hay preguntas que nuestras mediciones no responden.

**Dónde se rompe ahora.** El límite sigue siendo la CPU, solo que mucho más arriba. En la rampa F5, la t3.small deja de cumplir pasando 267,6 req/s (80 % de su techo predicho de 336,5), el contenedor pasando 314,3 req/s y el PC pasando 1.034 req/s. En la t3.small Standard el límite llega antes, entre 58 y 67 req/s, cuando los créditos se acaban. En el contenedor, si llega a formarse cola, el heap de 256 MB vuelve a ser un riesgo mientras no se fije `-Xmx`.

**Lo que el arreglo no resolvió.** El listado sigue sin paginación: con 2.000 lobbies el p95 es el doble que con 200 (45 a 62 ms contra 20 a 22 ms), porque cada respuesta lleva diez veces más lobbies, y el costo sigue creciendo con el tamaño de la base (exponente 0,50-0,64). `participaciones.lobbyId` sigue sin índice. El login tampoco cambió: BCrypt cuesta 83,6 ms de CPU por petición en la t3.small, así que sus 2 vCPU alcanzan para unos 24 logins por segundo como máximo. Ese límite no aparece en `mezcla-lectura`, que no tiene logins. En `mezcla-postman`, que sí los tiene, el codo queda al 51-71 % del techo.

**Lo que falta medir o decir.**

- **Carga.** `mezcla-lectura` no tiene escrituras ni BCrypt, y los porcentajes de las dos mezclas salen de la colección Postman, no del uso real. Cada lobby sembrado tiene un participante.
- **Datos.** Los datos siempre cupieron en la caché de WiredTiger. No probamos el caso en que no quepan, y ahí sí importaría el disco: cada lectura del EBS tarda 10 ms, contra 0,4 ms en el NVMe.
- **Entornos.** En el PC y el contenedor el generador comparte el equipo, aunque fijado en otros hilos. El PC usa Java 25 y MongoDB 9.0.4, distintos de los de las otras dos opciones, y Docker corre sobre la VM de WSL2, no sobre un Linux nativo. Medimos un solo tipo de instancia de nube; la c7a.2xlarge y la c7a.large solo tienen precio de ficha.
- **Hardware.** Las explicaciones de SMT, de la frecuencia y de la memoria salen de microbenchmarks de un hilo, no de contadores de hardware. No sabemos por qué Windows sostiene el turbo solo en el núcleo 0, ni qué causa el resto de la diferencia del login entre Windows y Linux.
- **Repeticiones.** En el PC, los endpoints baratos de F1 tienen de 10 a 13 muestras, menos de las 30 que pide el modelo. F6 con el código corregido tiene 2 repeticiones en el PC y el contenedor. Las pendientes de créditos salen de 2 a 5 puntos de CloudWatch por nivel. La predicción de datos ×10 la extrapolamos después de medir.
- **Costos.** El costo del PC usa precio, vida útil y tarifa de energía supuestos, y el TDP de ficha en lugar de un vatímetro. La transferencia supone que toda la salida medida va a internet durante 730 h, sin compresión ni CDN.
- **Código.** El arreglo es nuestro y no tiene pruebas automáticas, porque `src/test` está vacío. Lo validamos con F1 a F8 y con la colección Postman.

## Datos crudos y guiones

- **Datos crudos.** `lobbylink_perfv3/resultados/`, una carpeta por corrida. Las tablas del modelo, la validación y los créditos están en `resultados/_logs/`, y los precios de AWS y lo que cobró la consola, en `resultados/_aws_*`.
- **Guiones.** `campanas/campana.sh`, `campanas/campana_jar.sh` y la carpeta `telemetry/`.
- **Visor.** `dashboard/index.html` muestra todas las corridas.
- **Índice y comandos.** El anexo A del anexo técnico une cada sección con sus carpetas, y el anexo B da los comandos para repetir cada fase.
