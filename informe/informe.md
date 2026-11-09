# LobbyLink: en qué máquina debe correr

Arquitectura Computacional, UCC, proyecto final. Mediciones de `lobbylink_perfv3/`. El detalle de cada fase, las tablas completas y las rutas de los datos crudos están en `anexo_tecnico.md`. Las referencias "anexo, cap. X" apuntan a ese documento.

## Resumen

Medimos LobbyLink, una API REST de Spring Boot sobre MongoDB, en tres opciones: el PC de un integrante (Ryzen 7 7445HS), un contenedor Docker con 1 CPU y 1 GB para la app y otro igual para `mongod`, y una instancia EC2 t3.small. Las tres recibieron la misma carga a tasa fija (50 % listar lobbies, 50 % ver un lobby), con la misma semilla y la misma escala de 5 a 80 peticiones por segundo, 600 s por nivel. Un nivel pasa si el p95 es ≤ 1.000 ms con errores ≤ 1 %.

LobbyLink espera en la CPU, y la mayor parte de esa CPU la gasta `mongod`. En la t3.small, con el código original a 10 req/s, `us` es 39,9 % con `wa` 0,0 %, `mongod` usa 62 % de un núcleo y la app 34 %. La causa está en el código: listar lobbies hace dos consultas a la base por cada lobby (patrón N+1), y cada petición examina 20.412 documentos. Con el código original el contenedor y la t3.small pasan 10 req/s y el PC 20.

Corregimos el N+1 sin agregar índices. Cada petición pasa a examinar 602 documentos y las tres opciones pasan 80 req/s. También pasan el tráfico ×10 (100 req/s) y los datos ×10 (2.000 lobbies), que con el código original colapsan en las tres.

Recomendamos la t3.small en modo Unlimited con el arreglo. La infraestructura cuesta 16,78 USD al mes hasta 40 req/s y 21,26 USD a 80 req/s, con los créditos de CPU medidos en CloudWatch. Si los clientes están en internet y la carga se sostiene todo el mes, la transferencia de salida sube el total a 47,81 USD a 10 req/s, 167,80 USD a 40 y 334,74 USD a 80. Con el código original, servir 10 req/s en la misma instancia cuesta 35,91 USD al mes de infraestructura y 67,02 USD con transferencia.

## 1. La aplicación

LobbyLink es el backend de una aplicación para organizar partidas. Un usuario publica un lobby para un videojuego y otros se unen hasta llenarlo. Jeferson Morillo lo escribió para Diseño de Software. Lo elegimos porque arranca en nuestras máquinas sin servicios externos (solo MongoDB) y podemos cargarlo de forma repetible.

Es una API REST en Spring Boot 3.5.14 con 23 endpoints en 7 controladores, capas `controller` → `service` → `repository` y MongoDB con Spring Data. La autenticación es JWT sin estado y las contraseñas son hash BCrypt con factor 10.

Medimos los seis endpoints de la colección Postman del proyecto: registro, login, crear lobby, listar, ver y unirse. Leyendo el código, el costo se concentra en dos lugares.

- **Listar lobbies.** `LobbyServiceImpl.listLobbies` trae todos los lobbies abiertos sin paginación, y `toSummaryDto` hace dos consultas más por cada uno: un conteo de participantes (`countByLobbyId`) y la búsqueda del videojuego (`findById`). Con 200 lobbies son unas 400 consultas. `participaciones.lobbyId` no tiene índice, así que cada conteo recorre la colección.
- **Login y registro.** BCrypt con factor 10 hace 2¹⁰ rondas de cálculo dentro de la JVM. Es CPU pura y casi no toca la base.

La versión arreglada (`LobbyLink_backend_nplus1/`, `jars/disenofinal-nplus1-fix.jar`) cambia solo el listado. Cuenta los participantes de todos los lobbies con una agregación y lee los videojuegos con un `findAllById`. No agrega índices ni cambia la respuesta de la API. La medimos con el mismo protocolo que la original, cambiando solo el jar.

Cada corrida crea una base nueva con 1 videojuego, 20 usuarios y 200 lobbies de un participante. Empezamos de cero porque el listado recorre todos los lobbies, y con una base acumulada cada corrida mediría otra aplicación. Los 200 lobbies son un tamaño que declaramos nosotros, así que medimos también de 100 a 2.000 (capítulo 4).

## 2. Entornos medidos

|  | PC (máquina física) | Contenedor `a1m1` | EC2 t3.small |
| --- | --- | --- | --- |
| Procesador | Ryzen 7 7445HS (Zen 4), 6 núcleos, 12 hilos | el mismo Ryzen | Xeon Platinum 8259CL (Cascade Lake), 2,5 GHz |
| CPU para app y `mongod` | 8 hilos fijados (4 núcleos con SMT), compartidos | 1 CPU de cuota CFS para la app y 1 para `mongod` | 2 vCPU (1 núcleo con SMT), compartidas; línea base de 20 % por vCPU |
| Memoria | 15,2 GB | 1 GB por contenedor, en una VM de 7,4 GB | 1,9 GB |
| Disco | NVMe de 512 GB | disco virtual de WSL2 en el mismo NVMe | EBS gp3 de 20 GiB, por red |
| Software | Windows 11, Java 25, MongoDB 9.0.4 | Docker Desktop sobre WSL2, Java 21.0.12, MongoDB 7.0.45 | Ubuntu 26.04, Java 21.0.12, MongoDB 7.0.45 |
| Precio | sin precio por hora (capítulo 6) | fracción del PC (capítulo 6) | 0,0208 USD/h, us-east-1 |

Cada opción limita la CPU de otra forma. En el PC, `run.mjs` fija la app y `mongod` en los hilos 0 a 7 y el generador en los hilos 8 a 11. En el contenedor, el kernel da 100 ms de CPU por cada periodo de 100 ms y detiene al contenedor si los gasta antes (frenado o `throttled`). En la t3.small, las 2 vCPU son los dos hilos de un solo núcleo físico. En modo Unlimited puede pasar de la línea base y AWS cobra los créditos de más. En modo Standard, sin créditos, el hipervisor la deja en 0,4 vCPU y el resto aparece en Linux como `steal`.

Antes de cargar la app medimos el disco con `fio` y la red con `iperf3` (F0), para comparar lo que LobbyLink usa con lo que la máquina puede dar.

| F0 | PC | Contenedor | t3.small |
| --- | --- | --- | --- |
| Lectura aleatoria 4 KiB, IOPS (p50) | 41.903 (375 µs) | 79.766 (387 µs), cota superior por la caché de Windows | 3.049 (10.027 µs) |
| Escritura con `fsync`, IOPS | 1.488 | 1.155 | 354 |
| Lectura secuencial, MB/s | 1.306,8 | 1.410,6 | 127,3 |
| Red generador → servidor | mismo equipo | mismo equipo | 4.953 Mbit/s |

El disco de la t3.small se detiene en los límites que AWS pone al volumen gp3 (3.000 IOPS y 125 MB/s), y cada lectura tarda 10 ms porque cruza la red del centro de datos. En AWS el generador corre en otra instancia, una c7i-flex.large. En el PC y el contenedor comparte el equipo, fijado en sus propios hilos.

## 3. Cómo generamos la carga y qué medimos

**Carga a tasa fija.** `telemetry/rate.mjs` manda peticiones a una tasa fija λ, contesten o no, con llegadas de Poisson generadas con semilla. Es un modelo abierto, como los usuarios de una API, que llegan sin esperar a que el servidor termine con los demás. La latencia se mide desde la hora en que la petición debía salir. Así evitamos la omisión coordinada de un generador de bucle cerrado, que deja de mandar cuando el servidor se atasca y no mide las peticiones que debían salir durante el atasco. Una petición de más de 10 s cuenta como error con latencia de 10 s. Si el propio generador se atrasa más de 50 ms en p99, el nivel no cuenta.

**Mezcla.** `mezcla-lectura` usa las dos lecturas de lobbies de la colección Postman, listar y ver, en partes iguales. No crea datos, así que la carga es la misma del primer al último segundo. `mezcla-postman` recorre los seis endpoints, pero crea un lobby en una de cada seis peticiones y el listado se encarece durante la corrida. La usamos solo para validar el modelo.

**De dónde salen las tasas.** No usamos niveles supuestos como "100 usuarios". Las tasas salen de una cadena de fases.

1. F1 mide D, los ms de CPU por petición de cada endpoint, con un solo cliente durante 120 s. D es la CPU del proceso menos la de reposo, dividida entre las peticiones atendidas, por separado para la app y `mongod`.
2. Con la ley de utilización (U = λ·D), `telemetry/model.mjs` predice el techo X\_max = capacidad / Σ pᵢ·Dᵢ.
3. F5 sube la tasa del 10 % al 150 % de X\_max y busca dónde deja de cumplir el requisito.
4. F6 compara las tres opciones con la misma escala (5, 10, 20, 40 y 80 req/s), 600 s por nivel y 3 repeticiones con semillas distintas.
5. F7 multiplica por diez el tráfico y, aparte, los datos. La predicción queda escrita en un archivo antes de medir.
6. F8 sostiene 10 req/s durante 40 min o más para ver créditos de CPU y crecimiento de memoria.

F2 (costo contra tamaño de los datos), F3 (Amdahl y SMT) y F4 (cuotas del contenedor) explican los resultados.

**Requisito y regla de recomendación.** Un nivel pasa con p95 ≤ 1.000 ms y errores ≤ 1 %. El límite de 1.000 ms lo declaramos nosotros. Con el jar arreglado ningún nivel de F6 cambia de resultado si el límite es 300 o 500 ms, así que la recomendación no depende de él. Para recomendar una opción a una tasa λ pedimos además que su recurso más usado quede a ≤ 60 % de su capacidad. El resto es margen para picos y para el crecimiento de los datos.

**Qué mide el agente.** `telemetry/agent.mjs` corre fuera de la app y toma una muestra por segundo (cada 2 s en Windows). Mide:

- la CPU de la máquina (`us`, `sy`, `wa`, `steal`) y la de cada proceso;
- el RSS;
- las IOPS y los MB/s de disco;
- los bytes de red;
- en Docker, el frenado de la cuota;
- de `mongod`, las consultas, los documentos examinados y los fallos de caché de WiredTiger.

`report.mjs` cruza las muestras con la ventana de medición de cada nivel, sin el calentamiento.

**Reproducibilidad.** `campanas/campana.sh` corre las mismas fases en las tres opciones. Cada corrida usa una base nueva y guarda en su propia carpeta de `resultados/`:

- el registro del generador;
- el del agente;
- el log de la app;
- la configuración;
- el reposo previo.

Ninguna corrida sobrescribe otra. Los comandos y el índice de carpetas están en los anexos A y B del anexo técnico.

## 4. Resultados

### Costo por petición (F1)

D en ms de CPU por petición, app + `mongod`:

| Endpoint | PC | Contenedor | t3.small |
| --- | --- | --- | --- |
| Listar, jar base | 55,4 + 164,9 = 220,3 | 72,0 + 97,8 = 169,8 | 63,2 + 104,2 = 167,4 |
| Listar, jar arreglado | 3,9 + 3,4 = 7,2 | 4,5 + 2,4 = 6,9 | 4,5 + 2,6 = 7,1 |
| Ver | 5,1 | 5,1 | 4,2 |
| Login | 112,9 | 56,8 | 83,6 |
| Crear / unirse | 12,8 / 10,6 | 10,4 / 8,5 | 14,2 / 12,6 |
| X\_max `mezcla-lectura`, base / arreglado (req/s) | 71 / 1.288,9 | 20 / 262,3 | 23,3 / 336,5 |

Con el jar base, listar cuesta de 33 a 43 veces lo que ver, y `mongod` hace del 58 al 75 % del trabajo. `serverStatus` lo confirma: cada listado hace unas 206 `find` y 200 conteos, dos consultas por lobby. El arreglo baja el costo del listado entre 24 y 31 veces. Login y registro gastan el 96-99 % en la app (BCrypt).

### Crecimiento con los datos (F2)

Con un cliente, el costo del listado con el jar base crece con exponente 1,10 a 1,21 contra el número de lobbies. Con 1.600 lobbies un listado tarda 2,1 s en el PC y 2,4 s en la t3.small. Con el arreglado el exponente es de 0,50 a 0,64, y el listado de 1.600 lobbies cuesta 22 a 29 ms de CPU. Con el D de cada tamaño recalculamos lo que sostiene cada opción con la regla del 60 %. El orden de las opciones es el mismo de 100 a 1.600 lobbies, así que la recomendación no depende del tamaño de 200 (anexo, cap. 4.2).

### Paralelismo y cuotas (F3 y F4)

En el PC el listado se reparte casi sin pérdida entre hilos (fracción paralela p = 0,981). El máximo es 28,8 req/s con 8 clientes, con `mongod` a 572 % y la app a 153 % de un núcleo. La t3.small topa con 2 clientes, porque sus 2 vCPU son un núcleo. El segundo hilo del núcleo (SMT) aporta +84 % en login en el PC y +71 % en la t3.small, más que el 15-30 % que da la sesión 05 del curso.

En el contenedor, F4 cambia por separado la cuota de cada proceso. Con el jar base limita `mongod`. Con 1 CPU para cada uno el máximo es 18,0 req/s, dar 4 CPU a la app no lo cambia (17,8) y dar 2 CPU a `mongod` lo sube a 26,9. Con el jar arreglado limita la app, y el máximo con 1 CPU para `mongod` sube a 410 req/s, 23 veces más. Cuando la cuota de la app limita, el frenado llega a 3.951-5.160 ms/s.

### Predicción contra medición (F5)

| Opción y jar | X\_max predicho | Último λ que pasa (% del techo) | Utilización predicha / medida |
| --- | --- | --- | --- |
| PC, base | 71 | 35,8 (50 %) | 50 % / 55 % |
| Contenedor, base | 20 | 10,2 (51 %) | 51 % / 59 % |
| t3.small, base | 23,3 | 11,8 (51 %) | 51 % / 56 % |
| PC, arreglado | 1.288,9 | 1.034 (80 %) | 80 % / 70 % |
| Contenedor, arreglado | 262,3 | 314,3 (120 %) | 120 % / 88 % |
| t3.small, arreglado | 336,5 | 267,6 (80 %) | 80 % / 82 % |

Con el jar base, la utilización medida sigue a la predicha con 1 a 8 puntos de diferencia, así que el modelo describe bien el consumo. Lo que falla antes del techo es la latencia. Con el jar base un listado ocupa la CPU 150-210 ms, y bastan unas 5 peticiones en cola para pasar de 1 s. Por eso el codo está al 50-62 % del techo. Con 7 ms por listado hacen falta unas 140, y el codo sube al 80-90 % en el PC y la t3.small. El contenedor arreglado pasa el 120 % porque bajo carga su app gasta unos 2,8 ms por petición, no los 3,8 que midió F1 con un cliente.

### Carga sostenida (F6)

p95 en ms; el rango cubre las repeticiones:

| λ (req/s) | PC base | Contenedor base | t3.small base | PC arreglado | Contenedor arreglado | t3.small arreglado |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 218-245 | 236-245 | 255-276 | 22 | 23 | 15-16 |
| 10 | 218-236 | 408-478 | 393-408 | 22 | 22 | 12-13 |
| 20 | 236-255 | falla | falla | 21 | 22 | 12-15 |
| 40 | 629 y 827; falla en r3 |  |  | 21 | 21 | 13-14 |
| 80 | falla |  |  | 20 | 21 | 16 |

Cuando un nivel falla, el colapso es total. A 20 req/s la t3.small base responde 1,8 a 2,2 req/s con 89-95 % de errores. Con el jar arreglado las tres opciones pasan todos los niveles con 0 errores, y el PC pasa también 160 y 320 req/s (p95 de 17,7 a 19,2 ms).

Recursos en el último nivel que pasan las tres opciones (r1):

| Métrica | PC base 10 | Contenedor base 10 | t3.small base 10 | PC arreglado 80 | Contenedor arreglado 80 | t3.small arreglado 80 |
| --- | --- | --- | --- | --- | --- | --- |
| p50 / p95 / p99 (ms) | 20,7 / 218 / 245 | 72,7 / 408 / 765 | 22,4 / 393 / 605 | 9,8 / 19,9 / 22,4 | 10,6 / 20,7 / 22,4 | 7,8 / 16,4 / 35,9 |
| CPU de la máquina, promedio / pico | 19,4 % / 76 % | 10,2 % / 17,5 % de la VM | 48,2 % / 99,5 % | 15,7 % / 58 % | 6,6 % / 8,8 % de la VM | 28,8 % / 97,1 % |
| Núcleo (hilo) más ocupado, promedio / pico | 66 % / 100 % | 22 % / 41 % | 50 % / 100 % | 65 % / 100 % | 14 % / 20 % | 30 % / 99 % |
| `us` / `wa` | 8,9 % / no aplica | 5,0 % / 0,0 % | 39,9 % / 0,0 % | 6,0 % / no aplica | 2,9 % / 0,0 % | 23,8 % / 0,0 % |
| `steal`, promedio / pico | no aplica | 0 % / 0 % | 0,5 % / 29,6 % | no aplica | 0 % / 0 % | 1,2 % / 52,7 % |
| CPU app / `mongod` (% de un núcleo), promedio | 27 / 77 | 41 / 56 | 34 / 62 | 19 / 22 | 26 / 21 | 33 / 23 |
| CPU app / `mongod` (% de un núcleo), pico | 95 / 269 | 74 / 118 | 114 / 136 | 89 / 99 | 35 / 29 | 124 / 71 |
| Frenado de cuota (`throttled`, ms/s), promedio / pico | no aplica | 22 / 543 | no aplica | no aplica | 0 / 39 | no aplica |
| RSS app / `mongod` (MB), promedio | 241 / 96 | 217 / 80 | 260 / 189 | 246 / 132 | 219 / 82 | 250 / 162 |
| RSS app / `mongod` (MB), pico | 252 / 97 | 220 / 81 | 266 / 190 | 247 / 134 | 221 / 83 | 251 / 164 |
| Disco, IOPS / MB/s, promedio | 29 / 1,98 (todo el equipo) | 0 / 0,01 | 1 / 0,01 | 19 / 2,75 (todo el equipo) | 0 / 0,01 | 1 / 0,01 |
| Disco, IOPS / MB/s, pico | 3.200 / 238,6 (todo el equipo) | 16 / 0,12 | 46 / 0,51 | 1.038 / 388,3 (todo el equipo) | 21 / 0,13 | 50 / 0,46 |
| Red de salida (MB/s), promedio | loopback | 0,79 | 0,17 | loopback | 0,90 a 40 req/s | 1,39 |
| Red de entrada (MB/s), promedio / pico | loopback | 0,88 / 2,33 | 0,005 / 0,01 | loopback | 1,42 / 2,91 a 40 req/s | 0,037 / 0,052 |
| Documentos examinados por petición | 20.432 | 20.413 | 20.412 | 602 | 602 | 602 |
| Fallos de caché de WiredTiger | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % |

El pico es el mayor valor de una muestra (1 s en Linux, 2 s en Windows) dentro de la ventana de medición del nivel, no un promedio. En el PC el disco es el de todo el equipo, no el de LobbyLink, y sus picos de cientos de MB/s son de Windows, no de la app: la app y `mongod` leen 0 MB/s de disco. En el contenedor la red es la interfaz del contenedor de la app, así que incluye el tráfico hacia `mongod` y por eso la entrada supera la salida. Los picos de CPU de la t3.small llegan a 99-100 % de un hilo (a 10 req/s con el jar base, a 80 req/s con el arreglado), pero el promedio es 48,2 % y 28,8 %: la regla del 60 % se aplica al promedio sostenido. Fuentes: `report.mjs` sobre las mismas carpetas de la tabla.

El p50 de `mezcla-lectura` salta entre unos 20 y 170 ms según la repetición. La mitad de las peticiones son ver (unos 13 ms) y la otra mitad listar (unos 200 ms), y la mediana cae en el borde entre los dos grupos. Por eso comparamos con p95 y p99.

### Si la carga se multiplica por diez (F7)

Las predicciones de tráfico ×10 quedaron escritas antes de cada corrida. Por ejemplo, la del PC se escribió a las 08:49:31 y el generador arrancó a las 08:50:09, hora de Colombia. La carpeta de esa corrida dice 13:49 porque su nombre está en UTC, no porque hayan pasado 5 horas (`resultados/_logs/prediccion_x10_*.md`).

| Caso | Predicho a 100 req/s | Medido a 100 req/s | Datos ×10: 2.000 lobbies a 10 req/s |
| --- | --- | --- | --- |
| PC, base | 141 % de 8 hilos | 95 % de los 8 hilos, 100 % de errores | 99,18 % de errores |
| Contenedor, base | `mongod` 499 % de su cuota | app 97 % de su cuota, GC completo el 19,5 % del tiempo, 100 % de errores | 99,18 % de errores, GC completo el 77,3 % del tiempo |
| t3.small, base | 429 % | CPU 99,9 %, 100 % de errores | 99,18 % de errores |
| PC, arreglado | 8 % | 6,5 %, p95 19,9 ms | p95 45,4 ms |
| Contenedor, arreglado | app 38 % | app 33 %, p95 20,7 ms | p95 45,4 ms |
| t3.small, arreglado | 30 % | 34 %, p95 16,4 ms | p95 62,2 ms |

La predicción acertó en los seis casos qué opción pasa. El contenedor con el jar base mostró un límite que el modelo no incluye, el heap de la JVM. Por defecto la JVM toma un cuarto de la memoria visible, unos 256 MB en un contenedor de 1 GB, y con 1 CPU usa Serial GC. Cuando las peticiones se acumulan, sus objetos llenan el heap (243 de 247 MB) y la CPU de la app se va en recolectar. La predicción de datos ×10 no quedó escrita antes de medir. La extrapolamos después con F2, y pedía al menos 9,5 s de CPU por segundo, más de lo que tiene cualquiera de las tres opciones.

## 5. Dónde espera la aplicación y qué hardware lo explica

**CPU.** Es el único recurso que se agota. En la t3.small base a 10 req/s, `us` es 39,9 % con `wa` 0,0 %. Con un cliente, el p50 del listado (153,2 ms) es casi igual a su CPU (167,4 ms). La petición pasa su tiempo ejecutando consultas, no esperando al disco. Bajo carga se suma la espera en la cola de la CPU, y a 20 req/s la máquina llega a 99,9 % y el nivel colapsa. En la t3.small Standard sin créditos la espera aparece como `steal`, 78,8 % con `us` 16,8 % a 10 req/s, y solo pasa 2 req/s.

**Disco.** No participa. La t3.small hace 1 IOPS en promedio, el 0,28 % de las 354 escrituras con `fsync` por segundo que midió F0, y son las escrituras del journal de WiredTiger (0,82 de escritura contra 0,003 de lectura por segundo a 10 req/s). Los datos ocupan unos 10 MB de una caché de 256 a 7.287 MB, con 0 % de fallos. El EBS es unas 27 veces más lento que el NVMe en lectura aleatoria, pero eso solo importaría si los datos no cupieran en RAM.

**Red.** Tampoco limita. La salida es 1,39 MB/s a 80 req/s, que corresponde al tamaño medio de las respuestas (17,6 KB), y es el 0,22 % de lo que midió `iperf3`.

**Memoria.** Sobra mientras el nivel pasa: 449 MB de 1.905 en la t3.small, con 0,42 % del tiempo en pausas del GC. En los 40 min de F8 el RSS de la app sube de 310 a 324 MB con el jar base, sin señal de fuga. Solo crece cuando un nivel colapsa, porque las peticiones esperan en memoria. El caso extremo es el heap del contenedor en F7.

| Número medido | Componente | Por qué |
| --- | --- | --- |
| `us` 39,9 % con `wa` 0,0 %; 58-75 % de la CPU del listado en `mongod` | Núcleos del procesador | Cada una de las \~406 consultas del N+1 cuesta CPU fija en `mongod`. El arreglo baja su D 22 veces, y el techo con 1 CPU para `mongod` sube 23 veces |
| Exponente 1,10-1,21 y no 2 | Procesador y RAM (jerarquía de memoria) | Recorrer un documento en RAM cuesta unos 0,26 µs y una consulta unos 0,33 ms. Con estos tamaños domina la cantidad de consultas |
| SMT +84 % en login; la t3.small topa con 2 clientes | Núcleo con SMT y número de núcleos físicos (sesión 05) | Con p = 0,981, el límite de la t3.small es su único núcleo, no una parte secuencial del código. La explicación de SMT con BCrypt es nuestra, sin contadores de hardware |
| Login 56,0 ms en el Ryzen contra 83,1 ms en el Xeon, con el mismo software | Rendimiento por hilo (frecuencia × IPC) | BCrypt es cálculo puro. El listado cuesta casi igual en los dos, porque en Docker cada consulta paga la red virtual (`sy` 5,2 % ≈ `us` 5,0 %) |
| Codo al 50-62 % del techo con el jar base y al 80-90 % con el arreglado en el PC y la t3.small (el contenedor arreglado pasa al 120 %) | Cola frente a la CPU (sesión 10) | Con 150-210 ms por listado bastan 5 peticiones en cola para pasar de 1 s |
| 1 IOPS contra 354 escrituras con `fsync` por segundo; 0 % de fallos de caché | RAM y disco EBS (sesión 07) | Todo el conjunto de trabajo está en la caché de WiredTiger |
| Frenado de 3.951-5.160 ms/s; heap de 256 MB lleno en F7 | Cuota CFS y límite de memoria del contenedor | El kernel detiene el contenedor al gastar su cuota, y la JVM dimensiona su heap con el límite que ve |
| `steal` 78,8 % en Standard sin créditos | Hipervisor de AWS | Entrega solo la línea base del 20 % |

### Por qué el mismo código da resultados distintos en cada CPU

Las dos CPU se diferencian en dos cosas que se suman: cuántos núcleos le tocan a LobbyLink y cuánto tarda cada núcleo en hacer el mismo trabajo.

|  | AMD Ryzen 7 7445HS (PC y contenedor) | Intel Xeon Platinum 8259CL (t3.small) |
| --- | --- | --- |
| Microarquitectura | Zen 4, 2023 | Cascade Lake, 2.ª generación de Xeon Scalable, 2019 (ficha de T3 de AWS) |
| Tipo de procesador | De portátil, TDP de 35 W (ficha de AMD) | De servidor, para centros de datos |
| Núcleos | 6 núcleos y 12 hilos (agente) | Chip compartido con otros clientes de AWS; la t3.small recibe 2 vCPU, que son 1 núcleo con 2 hilos |
| Núcleos que usa LobbyLink | 4 núcleos (hilos 0 a 7, fijados) | 1 núcleo |
| Frecuencia | 3,2 GHz de base (agente y Administrador de tareas); turbo de hasta 4,7 GHz (ficha de AMD) | 2,5 GHz nominal (nombre del modelo, agente); turbo sostenido de hasta 3,1 GHz en todos los núcleos (ficha de T3 de AWS) |
| Caché L1 | 384 KB, 64 KB por núcleo (Administrador de tareas) | 64 KB de un núcleo: 32 KB de datos + 32 KB de instrucciones, compartidos por sus 2 hilos (`lscpu` en una t3.small, 2026-11-08) |
| Caché L2 | 6 MB, 1 MB por núcleo (agente y Administrador de tareas) | 1 MB de un núcleo, 16 vías, compartido por sus 2 hilos (`lscpu`) |
| Caché L3 | 16 MB para 6 núcleos (agente) | 35,75 MB (agente) para todos los núcleos del chip, compartida con las demás instancias del servidor físico |
| Límite de uso | Ninguno: la CPU es nuestra | Línea base del 20 % por vCPU; lo que pase de ahí se cobra en créditos (Unlimited) o se corta (Standard) |

El L1 y el L2 por núcleo son iguales en los dos procesadores (64 KB y 1 MB), así que la caché por núcleo no explica la diferencia de velocidad: la explican la frecuencia y el IPC. En la t3.small esa caché la comparten los 2 hilos del único núcleo, lo que apoya la hipótesis de que el segundo hilo (SMT) rinde menos de lo que parece. No medimos fallos de caché de CPU. `lscpu` confirma además 1 núcleo, 2 hilos por núcleo y KVM como hipervisor.

**Velocidad de un núcleo.** Un núcleo termina una tarea según su frecuencia (ciclos por segundo) multiplicada por su IPC (instrucciones por ciclo). El Zen 4 tiene cuatro años más de diseño que Cascade Lake, y en ficha llega a 4,7 GHz contra 3,1 GHz. El login lo muestra mejor que nada, porque BCrypt es cálculo puro dentro de la JVM. Con el mismo Java (21.0.12), el mismo MongoDB y Linux en los dos, cuesta 56,0 ms en el Ryzen y 83,1 ms en el Xeon, 1,48 veces más. Medimos la frecuencia sostenida de un hilo con el mismo microbenchmark en los dos entornos de esa comparación: 4,63 GHz dentro del contenedor, con cuota de 1 CPU y fijado a distintas vCPU de la VM (`resultados/_microbench_docker_20261108/`), y 3,07 GHz en la t3.small. El cociente es 1,51, casi igual al 1,48 del login, así que la frecuencia alcanza para explicarlo y no hace falta una ventaja de IPC del Zen 4 en BCrypt. La medición es aparte de las corridas de LobbyLink y no usa contadores de hardware, así que es una explicación compatible con los datos, no una prueba directa.

**Frecuencia y caché del Xeon, medidas (2026-11-08).** Corrimos dos microbenchmarks propios en otra t3.small del mismo tipo (`resultados/_microbench_20261108/`, `membench.c`). La frecuencia sale de una cadena de sumas dependientes, de un ciclo cada una. Con un hilo, el Xeon sostiene 3,07 GHz en la mayoría de las muestras de 5 s (3,075; 3,071; 3,076; 3,039; 3,071), y dos muestras bajan a 2,61 y 2,37 GHz. Coincide con el turbo de 3,1 GHz de la ficha de AWS, no con los 2,5 GHz del nombre del modelo. Con los dos hilos ocupados a la vez, cada uno rinde 2,82 GHz equivalentes, un 8 % menos; con este método no se separa si baja la frecuencia o si los dos hilos se estorban. La latencia de acceso a memoria, con acceso dependiente en orden aleatorio, es:

| Conjunto de datos | Latencia por acceso | En ciclos a 3,07 GHz | Nivel que atiende |
| --- | --- | --- | --- |
| 4 a 32 KB | 1,62 ns | 5 | L1 (32 KB) |
| 48 a 256 KB | 4,54 ns | 14 | L2 (1 MB) |
| 512 KB a 1 MB | 6,0 a 12,8 ns | 18 a 39 | borde del L2 |
| 2 a 4 MB | 24,7 a 29,9 ns | 76 a 92 | L3 |
| 8 a 256 MB | 100,9 a 118,1 ns | 310 a 360 | RAM |

Los escalones coinciden con los tamaños de `lscpu` (L1 de 32 KB, L2 de 1 MB). El L3 aparece solo hasta unos 4 MB, no hasta los 35,8 MB que reporta el sistema. Con 8 MB la latencia ya es la de la RAM. Es de esperar que el L3 efectivo sea menor porque lo comparten otros clientes del servidor, y que parte del salto sea de la tabla de páginas de 4 KB; no separamos las dos causas. Lo que esto dice de LobbyLink: si cada documento que `mongod` examina en un listado (unos 40.800 con el jar base) fuera un solo fallo a RAM de 118 ns, serían 4,8 ms de los 167,4 ms de CPU del listado, un 2,9 %. Es una estimación de orden de magnitud, no una cota superior, porque examinar un documento puede tocar varias líneas de caché: harían falta unos 22 fallos por documento para igualar los 104,2 ms de CPU de `mongod`. Apunta a que la CPU se va sobre todo ejecutando instrucciones (análisis de BSON, comparación y las 406 consultas), pero no lo demuestra. `us` y `wa` no sirven para esta pregunta: un hilo detenido por un fallo de caché cuenta como `us`, y `wa` solo refleja esperas de disco. Separar las dos cosas exige contadores de fallos de caché de CPU, que no pudimos medir.

**Frecuencia y caché del Ryzen, medidas (2026-11-08).** Corrimos el mismo microbenchmark en el PC, compilado para Windows y con el hilo fijado (`resultados/_microbench_ryzen_20261108/`, `membench_win.c`, `salida.txt`, `salida_por_hilo.txt`), con el portátil conectado a la corriente y el plan de energía Equilibrado. En el hilo lógico 0 la frecuencia sostenida es 4,7 GHz (4,710; 4,701; 4,678; 4,697; 4,507; 4,713), igual al turbo de la ficha de AMD. Pero fijado en cualquiera de los hilos lógicos 2 a 7 (núcleos 1 a 3), un solo hilo solo llega a 3,15 GHz (3,143 a 3,152 en cada muestra), cerca de la base de 3,2 GHz. Solo el núcleo 0 (hilos lógicos 0 y 1) alcanza los 4,7 GHz. Dos hilos en el mismo núcleo (0 y 1) mantienen 4,72 GHz cada uno, así que la cadena de sumas no detecta una bajada de frecuencia por SMT. Los hilos 8 y 9 dieron una muestra de 0,5 GHz por interferencia de otra tarea del equipo, y no la usamos. No sabemos por qué Windows sostiene el turbo solo en el núcleo 0. Lo medimos, no lo explicamos. Latencia de acceso por tamaño (hilo 0):

| Conjunto de datos | Latencia por acceso | En ciclos a 4,7 GHz | Nivel que atiende |
| --- | --- | --- | --- |
| 4 a 16 KB | 0,85 ns | 4 | L1 (32 KB de datos) |
| 48 a 256 KB | 2,96 a 2,99 ns | 14 | L2 (1 MB) |
| 512 KB a 1 MB | 3,74 a 4,53 ns | 18 a 21 | borde del L2 |
| 2 a 8 MB | 10,66 a 14,75 ns | 50 a 69 | L3 (16 MB) |
| 16 MB | 57,6 ns | 271 | borde del L3 |
| 32 a 256 MB | 85,7 a 112,9 ns | 403 a 531 | RAM |

Los escalones coinciden con L1 de 32 KB, L2 de 1 MB y L3 de 16 MB. Con el mismo cálculo del Xeon, 40.800 documentos examinados a 112,9 ns cada uno serían 4,6 ms de los 220,3 ms de CPU del listado en el PC, un 2,1 %. Tampoco aquí la estimación apunta a la memoria como causa principal, con la misma salvedad. La RAM del Ryzen (112,9 ns) y la del Xeon (118,1 ns) tardan casi lo mismo, y el Ryzen es más rápido en L1, L2 y L3 (0,85 ns contra 1,62 ns en L1, 10,7 contra 24,7 ns a 2 MB): la ventaja del Ryzen está en los niveles de caché y en la frecuencia, no en la memoria principal. Estas son latencias de acceso dependiente de un hilo, no un conteo de fallos de caché de CPU.

**Cuántos núcleos.** El PC le da a LobbyLink 4 núcleos físicos y la t3.small 1. Con el jar base, el PC tiene 4 veces la CPU, pero cada petición de `mezcla-lectura` le cuesta un 31 % más (112,7 contra 85,8 ms, por el efecto de Windows que se explica abajo). Su techo resulta 3 veces el de la t3.small (71 contra 23,3 req/s), no 4. F3 lo confirma: la t3.small deja de rendir más con 2 clientes, porque sus dos hilos comparten un núcleo, y el PC sigue subiendo hasta 8.

**Por qué el listado cuesta casi igual en las dos.** Un listado del jar base cuesta 169,8 ms en el contenedor y 167,4 ms en la t3.small, a pesar del núcleo más rápido del Ryzen. El listado no es cálculo puro. Son unas 406 consultas entre la app y `mongod`, y cada una pasa por el kernel. En el contenedor esas consultas cruzan la red virtual de Docker dentro de la VM de WSL2, y el kernel gasta tanto como el código (`sy` 5,2 % contra `us` 5,0 %). En la t3.small `mongod` usa la red del host y el kernel gasta la quinta parte que el código (`sy` 7,8 % contra `us` 39,9 %). Lo que el Ryzen gana en cada instrucción lo pierde en cada consulta. No aislamos el costo de la red virtual en una prueba aparte.

**Por qué el PC nativo es más lento que el contenedor sobre el mismo Ryzen.** El login cuesta 112,1 ms en Windows nativo y 56,0 ms en el contenedor, sobre el mismo chip. Repetimos la prueba con Java 21 en Windows y el p50 fue 111,9 ms, así que la causa no es la versión de Java. Sigue a Windows nativo frente a Linux. El microbenchmark del Ryzen muestra una causa parcial: en Windows, un hilo fijado fuera del núcleo 0 corre a 3,15 GHz y no a 4,7 GHz (cociente 1,49). El cociente del login es 2,0 (112,1 / 56,0), así que la frecuencia explica como mucho una parte. Dentro del contenedor, el mismo microbenchmark da 4,63 GHz en todas las vCPU, 1,47 veces los 3,15 GHz de Windows. El resto queda sin explicar, y no sabemos en qué núcleos corrió el login de F1 (anexo, cap. 7.3).

En resumen, el Xeon de la t3.small es un núcleo más lento por hilo (1,48 veces en BCrypt), y además LobbyLink recibe uno solo, racionado al 20 % por la línea base. El Ryzen es más rápido por hilo y da 4 núcleos completos, pero Windows y la red virtual de Docker le quitan parte de esa ventaja. Con el jar arreglado las dos CPU sobran para 80 req/s, y por eso la diferencia de hardware no cambia la recomendación.

## 6. Comparación y costo

|  | PC | Contenedor 1 × 1 | t3.small Unlimited | t3.small Standard | c7a.2xlarge (equivalente al PC, sin medir) |
| --- | --- | --- | --- | --- | --- |
| Jar base: mayor λ con F6 aprobado y recurso ≤ 60 % | 20 req/s | 10 req/s (`mongod` 56 % de su cuota) | 10 req/s (CPU 48,2 %) | 2 req/s sin créditos | no medido |
| Jar arreglado a 80 req/s | pasa, 5 % de los 8 hilos (llega a 320 req/s) | pasa, app al 26 % de su cuota | pasa, CPU 28,8 % | pasa hasta 20 req/s, el máximo probado | no medido |
| Qué falta | No es un servidor: portátil con Windows, sin IP pública ni redundancia | Corre sobre el PC y hereda sus faltas | Un solo núcleo físico; sobre el 20 % de CPU cobra créditos | Sin créditos queda en 0,4 vCPU | Capacidad que LobbyLink arreglado no usa |
| Ficha | Zen 4, 6 núcleos / 12 hilos, 15,2 GB | Cuotas de 1 CPU y 1 GB por contenedor | Xeon 8259CL, 2 vCPU (1 núcleo), 2 GiB | Igual que Unlimited | AMD EPYC Genoa (Zen 4), 8 vCPU = 8 núcleos sin SMT, 16 GiB |
| Costo mensual de infraestructura | 129.000-134.000 COP (declarado), 39,84-41,39 USD | 21.500-22.400 COP (1/6 del PC), 6,64-6,92 USD | 16,78 USD hasta 40 req/s; 21,26 USD a 80 | 16,78 USD | 301,31 USD (0,41056 USD/h × 730 h + 1,60 USD de EBS) |
| Costo mensual con transferencia a internet | sin cobro por GB (no incluye el plan de internet) | sin cobro por GB (no incluye el plan de internet) | 47,81 USD a 10 req/s; 167,80 a 40; 334,74 a 80 | 47,81 USD a 10 req/s | 614,79 USD a 80 req/s |
| Costo por 1.000 peticiones a 80 req/s | 0,61-0,64 COP (0,00019-0,00020 USD) | 0,10 COP (0,00003 USD) | 0,00010 USD; 0,0016 USD con transferencia | no sostiene 80 req/s en el tiempo | 0,0014 USD, si sostuviera 80 req/s; 0,0029 USD con transferencia |

Cómo calculamos cada costo:

- **t3.small.** 730 h × 0,0208 USD, más 1,60 USD de EBS (20 GiB × 0,08 USD/GB-mes, precio de ejemplo de AWS), más los créditos excedentes medidos.
- **Transferencia a internet.** 0,09 USD/GB tras los 100 GB gratis del mes (tarifa oficial de AWS para us-east-1, `resultados/_aws_precios_20261108/precios.md`). Usamos la salida medida en F6: 445 GiB al mes a 10 req/s, 1.778 a 40 y 3.583 a 80, o sea 31,03, 151,02 y 313,48 USD. Supone clientes en internet y esa carga durante las 730 h.
- **PC.** Depreciación de 4.000.000 COP en 36 meses más energía con el TDP de ficha (35 W) a 700-900 COP/kWh. Precio, vida útil y tarifa son supuestos nuestros. Convertimos con la TRM oficial vigente el 2026-11-08, 3.237,83 COP por USD (`resultados/_aws_precios_20261108/trm_datos_gov.json`).
- **Contenedor.** La sexta parte del PC, porque sus cuotas son 2 de los 12 hilos.
- **Equivalencia del contenedor en la nube.** La instancia de AWS más parecida a sus dos cuotas de 1 CPU es la c7a.large: 2 vCPU que son 2 núcleos físicos Zen 4, con 4 GiB (el contenedor tiene 2 GB en total). Su precio sale del mismo archivo público de AWS (`resultados/_aws_precios_20261107/ec2_ondemand_us-east-1_linux.json`): 0,10264 USD/h × 730 h = 74,93 USD, más 1,60 USD de EBS, 76,53 USD al mes. No la medimos.
- **c7a.2xlarge.** Es la instancia de AWS más parecida al PC: mismo núcleo Zen 4 y 8 núcleos físicos sin SMT, contra los 6 núcleos y 12 hilos del PC. Su precio sale del archivo público de AWS del 2026-11-07 (`resultados/_aws_precios_20261107/precios.md`): 0,41056 USD/h × 730 h = 299,71 USD, más 1,60 USD de EBS. No la medimos. Si solo se quisieran los 4 núcleos que el PC le da a LobbyLink, la c7a.xlarge (4 vCPU, 8 GiB) cuesta 149,85 USD más 1,60 USD de EBS.
- **Equivalencia PC en la nube.** El PC cuesta 39,84-41,39 USD al mes, una fracción de los 301,31 USD de la c7a.2xlarge, y eso es lo que paga la falta de servidor, IP y redundancia. Con transferencia, la t3.small supera al PC desde unos 8 req/s sostenidos, porque el PC no paga por GB.
- **Costo por 1.000 peticiones.** Costo por hora / (req/s × 3,6).

**Créditos de CPU medidos.** En Unlimited, AWS cobra a 0,05 USD por vCPU-hora la CPU que pasa de la línea base. Medimos en CloudWatch la pendiente del saldo excedente en cada nivel de F6.

| Versión y λ | CPU de la máquina | Créditos excedentes (créditos/h, mediana de 3) | USD/mes |
| --- | --- | --- | --- |
| Base, 10 req/s | 48,2 % | 31,4 | 19,13 |
| Arreglado, 40 req/s | 14,9 % | −5,9 (no cobra) | 0 |
| Arreglado, 80 req/s | 28,8 % | 7,4 | 4,48 |

La medición confirma la línea base del 20 % de la ficha: el jar arreglado no cobra a 40 req/s (14,9 % de CPU) y sí a 80 (28,8 %). Lo comprobamos con F8. En 40 minutos a 10 req/s con el jar base, la instancia gastó 59,3 créditos por hora, 35,3 más que los 24 que gana, y la pendiente medida del saldo fue 35,3. Con el código original los créditos (19,13 USD) cuestan más que la instancia (15,18 USD).

## 7. Recomendación

**Si la carga se multiplica por diez, lo primero que se rompe es la CPU, por el listado con N+1.** Con el código original, a 100 req/s las tres opciones tienen 100 % de errores: la t3.small llega a 99,9 % de CPU y el PC a 95 % de sus 8 hilos. Con 2.000 lobbies a 10 req/s tienen 99,18 % de errores, porque cada listado examina N² documentos (F2: ×4 al duplicar los lobbies), aunque la CPU aún crece con exponente 1,10-1,21 porque domina el costo por consulta; con 2.000 lobbies la parte cuadrática ya es el 42-67 % de la CPU de `mongod`. En el contenedor el límite que cede primero es la memoria: el heap de 256 MB se llena (243 de 247 MB) y el GC completo ocupa el 19,5 % del tiempo. Con el arreglo no se rompe nada: la CPU queda entre 6,5 y 34 % y el p95 entre 16,4 y 20,7 ms a 100 req/s (sección 4, F7).

Recomendamos desplegar LobbyLink con el arreglo del N+1 en una EC2 t3.small en modo Unlimited, con 20 GiB de EBS gp3. La infraestructura cuesta 16,78 USD al mes hasta 40 req/s y 21,26 USD a 80 req/s. Con clientes en internet y carga sostenida, el total es 47,81 USD a 10 req/s, 167,80 a 40 y 334,74 a 80: la red no limita el rendimiento, pero domina el costo. A 80 req/s la CPU queda en 28,8 %, por debajo del 60 % de la regla, con p95 de 16 ms y 0 errores en 3 repeticiones. Atiende 100 req/s con 34 % de CPU y 2.000 lobbies con p95 de 62 ms.

El arreglo pesa más que la máquina. Pasar de la t3.small al PC multiplica el techo del jar base por 3 (de 23,3 a 71 req/s). Arreglar el código en la misma t3.small lo multiplica por 14 (a 336,5 req/s). Si hubiera que desplegar el código original, la recomendación sería la misma instancia solo hasta 10 req/s, por 35,91 USD al mes (67,02 USD con transferencia), y ninguna de las tres opciones resistiría ×10.

Descartamos las demás opciones por lo siguiente.

- **t3.small Standard.** Sin créditos atiende 2 req/s con el jar base. Con el arreglado, el gasto de créditos iguala a la ganancia entre 58 y 67 req/s, y por encima de eso la instancia caería a la línea base. Unlimited cuesta lo mismo hasta 40 req/s sin ese riesgo.
- **PC.** Es la opción de mayor capacidad medida, pero es un portátil con Windows, sin IP pública ni redundancia, y su costo depende de supuestos. No lo descartamos por precio: cuesta 39,84-41,39 USD al mes, menos que la t3.small con transferencia desde unos 8 req/s sostenidos.
- **Contenedor.** Pasa la misma carga que la t3.small, pero corre sobre el PC. Para desplegarlo en un servidor habría que fijar el heap con `-Xmx` en proporción a su límite.
- **c7a.2xlarge.** En infraestructura cuesta 18 veces la t3.small (1,8 veces a 80 req/s con transferencia, 614,79 contra 334,74 USD), y LobbyLink arreglado no necesita esa capacidad.

## 8. Limitaciones

- En el PC y el contenedor el generador comparte el equipo, aunque en hilos propios. En AWS corre en otra instancia.
- El PC usa Java 25 y MongoDB 9.0.4, distintos de los del contenedor y la t3.small. Docker corre sobre la VM de WSL2, no en un Linux nativo.
- Medimos la frecuencia y la latencia de memoria del Xeon y del Ryzen, pero con un microbenchmark de un hilo, no con contadores de hardware. Los del Xeon corrieron en otra t3.small del mismo tipo, no en la de las corridas F1-F8, y los del Ryzen no registran en qué núcleos corrió cada corrida de LobbyLink. Las explicaciones de SMT y del login en Windows son hipótesis coherentes con los datos, no mediciones directas.
- En el PC, los endpoints baratos de F1 tienen de 10 a 13 muestras, menos de las 30 que pide el modelo. F6 con el jar arreglado tiene 2 repeticiones en el PC y el contenedor.
- `mezcla-lectura` no incluye escrituras ni BCrypt. Con `mezcla-postman` el codo queda al 51-71 % del techo. Cada lobby tiene un participante, y los datos siempre cupieron en la caché.
- Las pendientes de créditos salen de 2 a 5 puntos de CloudWatch por nivel. El precio de EBS es el de ejemplo de AWS, y el costo del PC usa supuestos declarados, sin vatímetro. La transferencia supone que toda la salida medida va a internet durante las 730 h, sin compresión ni CDN.
- Medimos un solo tipo de instancia de nube. El arreglo del N+1 es nuestro y no tiene pruebas automáticas (`src/test` está vacío).

La lista completa, con el efecto de cada limitación sobre los números, está en el anexo (cap. 12).

## Datos crudos y guiones

- **Datos crudos.** Están en `lobbylink_perfv3/resultados/`, una carpeta por corrida con `load.ndjson`, `agent.ndjson`, `app.log`, `run.json` e `idle.json`. Las tablas de modelo, validación y créditos están en `resultados/_logs/`. Los precios de AWS y lo que cobró la consola están en `resultados/_aws_*`.
- **Guiones.** `campanas/campana.sh`, `campanas/campana_jar.sh` y la carpeta `telemetry/`.
- **Visor.** `dashboard/index.html` muestra todas las corridas.
- **Índice y comandos.** El anexo A del anexo técnico une cada capítulo con sus carpetas, y el anexo B da los comandos para repetir cada fase.
