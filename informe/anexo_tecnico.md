# LobbyLink: anexo técnico

Arquitectura Computacional, UCC, proyecto final. Mediciones de `lobbylink_perfv3/`, noviembre de 2026. Es la versión completa del informe: el detalle de cada fase, las tablas completas, las limitaciones y las rutas de los datos crudos. El informe entregado (`informe.md`) resume este documento y lo cita como "anexo, cap. X".

## 0. Resumen

Medimos LobbyLink, una API REST de Spring Boot sobre MongoDB, en tres opciones: el PC de un integrante (Ryzen 7 7445HS), un contenedor Docker con 1 CPU y 1 GB para la app y otro igual para `mongod`, y una instancia EC2 t3.small. En las tres usamos la misma carga a tasa fija (50 % listar lobbies, 50 % ver un lobby), la misma semilla y la misma escala de 5 a 80 peticiones por segundo, durante 600 s por nivel. El requisito para "pasar" es p95 ≤ 1.000 ms con errores ≤ 1 %.

La aplicación espera en la CPU, y la mayor parte de esa CPU la gasta `mongod`. En la t3.small, con el código original y 10 req/s, la máquina está ocupada el 48,2 % del tiempo con `iowait` de 0 %. `mongod` usa 62 % de un núcleo y la app 34 %. Los fallos de caché de WiredTiger son 0 %, así que el disco no participa. La causa está en el código: `GET /api/lobbies` hace dos consultas a la base por cada lobby que devuelve (patrón N+1). Cada petición de la mezcla examina 20.412 documentos en `mongod`. Con 20 req/s la t3.small ya no responde: 88,9 % de las peticiones vencen el tiempo límite de 10 s. El contenedor pasa 10 req/s y falla en 20. El PC pasa 20 req/s en las tres repeticiones, y 40 en dos de las tres.

Corregimos el N+1 sin agregar índices: el conteo pasa a una sola agregación y los videojuegos se leen en una consulta. Con ese cambio cada petición examina 603 documentos, la CPU por petición baja de 96,67 ms a 10,05 ms y las tres opciones pasan los 80 req/s. En la t3.small, a 80 req/s, el p95 es 16,4 ms y la máquina está ocupada el 28,8 %. También pasa la prueba de ×10: 100 req/s con p95 de 16 ms, y 2.000 lobbies con p95 de 62 ms. Con 20.000 lobbies, cien veces los datos, falla el 100 % de las peticiones por falta de memoria, no de CPU, porque el listado sin paginar arma en la JVM una respuesta con todos los lobbies. El disco tampoco limita cuando los datos no caben en memoria: con 1.000.000 de lobbies (3.117 MB) y 400 req/s hace 365 IOPS, el 12 % de lo que midió F0 (capítulo 9.1).

Recomendamos desplegar LobbyLink con el arreglo del N+1 en una EC2 t3.small en modo Unlimited. Con el arreglo, hasta 40 req/s no supera la línea base de CPU que incluye su precio y cuesta 16,78 USD al mes con disco. A 80 req/s usa 28,8 % de su CPU y los créditos excedentes medidos en CloudWatch suben la infraestructura a 21,26 USD al mes. Con clientes en internet y carga sostenida, la transferencia de salida sube el total a 47,81 USD a 10 req/s, 167,80 a 40 y 334,74 a 80 (capítulo 8.1). Con el código original, servir solo 10 req/s ya cuesta 35,91 USD al mes, porque los créditos excedentes (19,13 USD) superan el precio de la instancia. Sin el arreglo, ninguna de las tres opciones resiste ×10, así que cambiar de máquina no resuelve el problema.

<!-- Cifras del resumen: ec2_t3small-unl/f6-mezcla-lectura-r1 (jar base, 10 y 20 req/s), ec2_t3small-unl-nplus1/f6-mezcla-lectura-r1 (jar arreglado, 10 y 80 req/s), ec2_t3small-unl-nplus1/f7-*, F6 de windows y docker (jar base) para 40 y 10 req/s. Precio: resultados/_aws_precios_20261107/precios.md. Créditos: resultados/_logs/creditos_ec2_unl_20261107.md (capítulo 8.1). Costo por 1.000 peticiones y comparación con PC, contenedor y c7a.2xlarge: capítulo 8. -->

## 1. La aplicación

### 1.1 Qué es LobbyLink

LobbyLink es el backend de una aplicación para que jugadores organicen partidas. Un usuario publica un lobby para un videojuego, con fecha, hora y un número máximo de cupos. Otros usuarios lo ven en la lista de lobbies abiertos y se unen hasta que se llena. Alrededor de eso la aplicación maneja equipos dentro de un lobby, invitaciones entre usuarios, un catálogo de videojuegos y notificaciones.

Jeferson Morillo escribió LobbyLink para la clase de Diseño de Software de cuarto semestre. La elegimos porque es una aplicación sencilla que cumple lo que pide el enunciado: una API con base de datos que podemos correr y cargar nosotros mismos. También cumple las dos condiciones que pide el enunciado. Arranca en nuestras máquinas sin servicios externos, porque solo necesita MongoDB en `localhost:27017`. Además podemos generar carga repetible, con un generador propio que usa semilla y una base de datos nueva en cada corrida.

### 1.2 Cómo está construida

Es una API REST en Spring Boot 3.5.14. `pom.xml` declara Java 17, y la medimos con Java 21 y 25. Guarda los datos en MongoDB con Spring Data. El código está en el paquete `com.jefer.disenofinal`, en capas: `controller` recibe la petición HTTP, `service` (interfaz e implementación en `service/impl`) tiene la lógica y `repository` habla con MongoDB. Los documentos están en `model` y los objetos de respuesta en `dto`. `GlobalExceptionHandler` convierte las excepciones en respuestas HTTP con código de error.

La autenticación no guarda estado en el servidor. Al iniciar sesión la app entrega un JWT con validez de 24 horas (`jwt.expiration=86400000`), y cada petición protegida lo presenta. Las contraseñas se guardan como hash BCrypt con factor de costo 10.

La API tiene 23 endpoints en 7 controladores:

| Recurso | Ruta base | Endpoints |
| --- | --- | --- |
| Usuarios | `/api/usuarios` | registro, login, cambiar gamertag |
| Lobbies | `/api/lobbies` | listar, crear, ver, unirse, salir, cancelar, completar |
| Equipos | `/api/equipos` | crear, listar, agregar miembro |
| Invitaciones | `/api/invitaciones` | enviar, aceptar, rechazar, listar |
| Participaciones | `/api/participaciones` | listar, asignar a equipo |
| Notificaciones | `/api/notificaciones` | listar, marcar como leída |
| Videojuegos | `/api/videojuegos` | crear, listar |

### 1.3 Qué medimos y qué hace costoso a cada endpoint

Medimos los seis endpoints que recorre la colección Postman del proyecto (`LobbyLink_Postman_Collection.json`): registro, login, crear lobby, listar lobbies, ver un lobby y unirse a un lobby. Leyendo el código, el costo de cada uno se concentra en tres puntos.

**Listar lobbies.** `LobbyServiceImpl.listLobbies` (`service/impl/LobbyServiceImpl.java:52-65`) trae todos los lobbies en estado `PUBLISHED` y todos los `FULL`, sin paginación. Luego convierte cada uno con `toSummaryDto` (línea 170). Para cada lobby, ese método hace dos consultas más a MongoDB. La primera es `participacionRepository.countByLobbyId` (línea 176), que cuenta los participantes para calcular los cupos libres. La segunda es `videojuegoRepository.findById` (línea 177), que busca el nombre del videojuego. Con 200 lobbies, un listado son unas 400 consultas a la base. La colección `participaciones` no tiene índice sobre `lobbyId` (`model/Participacion.java`), así que cada conteo recorre la colección. Por eso el costo crece más rápido que el número de lobbies.

**Login y registro.** `UsuarioServiceImpl` calcula el hash con `BCrypt.hashpw(..., BCrypt.gensalt(10))` al registrar (línea 39) y lo verifica con `BCrypt.checkpw` al iniciar sesión (línea 48). Factor 10 significa 2¹⁰ rondas del algoritmo de clave de Blowfish. Es trabajo de CPU dentro de la JVM, a propósito lento para frenar ataques de fuerza bruta, y casi no toca la base.

**Ver, crear y unirse.** Leen o escriben un lobby por su identificador, más un conteo de participantes en el caso de unirse (línea 118). Son baratos frente a los dos anteriores.

La tabla del capítulo 4.1 da el costo medido de cada uno.

### 1.4 El arreglo del N+1

La versión arreglada (`LobbyLink_backend_nplus1/`, jar en `jars/disenofinal-nplus1-fix.jar`) cambia solo el listado. Cuenta los participantes de todos los lobbies en una sola agregación de MongoDB y lee todos los videojuegos necesarios con una sola llamada a `findAllById`. No agrega índices ni cambia los datos. Comparamos las dos versiones con la misma carga. En la t3.small, a 10 req/s, `mongod` pasó de 103,1 `find` y 99,6 conteos por petición a 4,5 `find` y 1 agregación (`ec2_t3small-unl/f6-mezcla-lectura-r1` contra `ec2_t3small-unl-nplus1/f6-mezcla-lectura-r1`). El capítulo 10 tiene el detalle.

### 1.5 Datos de prueba

Cada corrida crea una base de datos nueva y siembra 1 videojuego, 20 usuarios y 200 lobbies, cada uno con un solo participante (su creador). Empezamos siempre de cero porque `GET /api/lobbies` recorre todos los lobbies: con la base acumulada de corridas anteriores, cada corrida mediría una aplicación distinta. Con estos datos MongoDB usa 9-10 MB de caché de WiredTiger, de 440 MB configurados en la t3.small. Todos los datos caben en RAM.

Los 200 lobbies no salen de una medición. Es un tamaño de referencia que heredamos de nuestras mediciones anteriores (v1 y v2). Lo mantenemos para que todas las corridas sean comparables entre sí. Es el segundo número que declaramos, junto con el requisito de latencia. No sabemos cuántos lobbies abiertos tendría LobbyLink en uso real, así que no tratamos el tamaño como fijo. Medimos el listado con 100, 200, 400, 800 y 1.600 lobbies (F2) y la carga sostenida con 2.000 (F7). La sección 4.2 muestra que la recomendación es la misma con cualquiera de esos tamaños. Los 20 usuarios tienen el mismo origen, pero no cambian el costo del listado, que depende de los lobbies y no de los usuarios.

## 2. Entornos medidos

El enunciado pide comparar una máquina física, una instancia de nube con su ficha y precio real, y un contenedor con límites definidos por nosotros. Medimos una opción de cada tipo. La t3.small la medimos dos veces, en modo Unlimited y en modo Standard, porque los dos modos reparten la CPU de forma distinta.

Todos los datos de esta sección salen de lo que registraron nuestras herramientas: la línea `machine` y `mongoinfo` del agente (`agent.ndjson`), los `run.json` de cada corrida y las sondas F0. Los únicos datos de ficha son los de AWS y AMD, y van marcados como tales.

### 2.1 Las tres opciones

| | PC (máquina física) | Contenedor `a1m1` | EC2 t3.small |
| --- | --- | --- | --- |
| Procesador | AMD Ryzen 7 7445HS (Zen 4), 6 núcleos, 12 hilos | el mismo Ryzen | Intel Xeon Platinum 8259CL a 2,5 GHz (Cascade Lake) |
| Caché del procesador | L2 6 MB, L3 16 MB | la misma | L1 64 KB (32 + 32) y L2 1 MB por núcleo, compartidos por sus 2 hilos; 35,75 MB (36.608 KB) de L3, compartida con otros clientes del servidor físico (`lscpu` en i-0cc5194ca3f1502e5, t3.small us-east-1c, 2026-11-08, ya terminada) |
| CPU que pueden usar la app y `mongod` | 8 hilos fijados (0-7), es decir 4 núcleos con SMT, compartidos por los dos procesos | 1 CPU para la app y 1 CPU para `mongod`, cada una con su cuota CFS | 2 vCPU compartidas por los dos procesos. Según la ficha, la línea base es 20 % de cada vCPU |
| Memoria | 15,2 GB (15.599 MB) | 1 GB para la app y 1 GB para `mongod`, dentro de una VM de 7,4 GB | 1,9 GB (1.905 MB) |
| Disco | SSD NVMe de 512 GB | disco virtual de la VM de WSL2, guardado en el mismo NVMe | volumen EBS gp3 de 20 GiB, por red |
| Sistema | Windows 11 Home 10.0.26300 | Linux de la VM de WSL2 bajo Docker Desktop 29.8.2 | Ubuntu 26.04.1 LTS, kernel 7.0.0-1016-aws |
| Precio de referencia | sin precio por hora (capítulo 8) | fracción del PC según la cuota (capítulo 8) | 0,0208 USD/h bajo demanda, us-east-1 |

### 2.2 Qué CPU ve cada proceso

La capacidad de cada opción no es la cantidad de CPU de la máquina. Es la que el sistema deja usar a la app y a `mongod`, y cada opción la limita con un mecanismo distinto.

**PC.** `run.mjs` fija la app y `mongod` en los hilos 0 a 7 y el generador de carga en los hilos 8 a 11 (`run.json`: `srvMask` 255, `genMask` 3840). Los 8 hilos son 4 núcleos físicos con dos hilos cada uno (SMT). Dos hilos del mismo núcleo comparten sus unidades de ejecución y sus cachés L1 y L2, así que 8 hilos rinden menos que 8 núcleos. Fijar `mongod` requiere una terminal de administrador. En las 41 corridas de la campaña del PC quedó fijado (`pinned.mongod: ok`). Solo falló en las 3 corridas de la prueba de JVM del capítulo 7.3.

**Contenedor.** El archivo `envs/compose.yml` pone `cpus: 1` y `mem_limit: 1g` a cada contenedor. El agente lee de cgroups `cpu.max = 100000 100000`. Eso quiere decir que el kernel le da al contenedor 100 ms de CPU por cada periodo de 100 ms. Si los gasta antes de que termine el periodo, el planificador CFS lo detiene hasta el siguiente. A ese bloqueo lo llamamos frenado (`throttled`) y lo medimos en el capítulo 4.4. La cuota limita tiempo de CPU, no núcleos: el contenedor puede correr en cualquiera de las 12 CPU de la VM, pero en total no pasa de 1 CPU. Docker Desktop corre esa VM sobre Hyper-V con 12 CPU y 7,4 GB (`docker`: `CPUs=12 | Mem=7919517696`). Por eso el contenedor mide "VM más cuota", no un Linux instalado directamente en el equipo.

**t3.small.** Tiene 2 vCPU. Según la documentación de AWS, en las instancias con SMT "cada hilo se representa como una vCPU", y la t3.small tiene por defecto 1 núcleo con 2 hilos por núcleo. Sus 2 vCPU son entonces los dos hilos de un solo núcleo físico del Xeon, que comparten sus unidades de ejecución y sus cachés L1 y L2, igual que dos hilos del PC. La ficha de AWS da una línea base de 20 % por vCPU y 24 créditos de CPU por hora. Un crédito es una vCPU al 100 % durante un minuto. El procesador que registró el agente, Xeon Platinum 8259CL, es de la segunda generación de la serie 8000 que nombra la ficha de T3, con turbo sostenido de hasta 3,1 GHz en todos los núcleos. El generador c7i-flex.large también es 1 núcleo con 2 hilos. Fuentes y fecha de consulta en `resultados/_aws_precios_20261107/precios.md`. En **Unlimited** la instancia puede pasar de esa línea base, y AWS cobra los créditos que gaste de más (capítulo 8.1). En **Standard**, cuando se acaban los créditos, el hipervisor la limita a la línea base: 0,4 vCPU entre las dos. La CPU que el hipervisor no entrega aparece en Linux como `steal`.

### 2.3 Lo que puede dar el hardware (F0)

Antes de cargar la aplicación medimos el disco y la red de cada opción con `setup/sondas.sh`. Así tenemos con qué comparar lo que la aplicación usa. `fio` escribe un archivo de 1 GiB con E/S directa, sin la caché del sistema operativo, y corre tres pruebas de 60 s:

- `randread`: lectura aleatoria de 4 KiB con profundidad de cola 32. Es lo que pediría una base de datos que no cabe en RAM.
- `syncwrite`: escritura de 4 KiB con profundidad 1 y `fsync` después de cada escritura. Es lo que hace el journal de WiredTiger al confirmar una escritura.
- `seqread`: lectura secuencial de 1 MiB con profundidad 8.

| Prueba | PC | Contenedor | t3.small (EBS gp3) |
| --- | --- | --- | --- |
| Lectura aleatoria 4 KiB, IOPS | 41.903 | 79.766 | 3.049 |
| Lectura aleatoria, latencia p50 / p99 | 375 / 2.408 µs | 387 / 594 µs | 10.027 / 11.338 µs |
| Escritura con `fsync`, IOPS | 1.488 | 1.155 | 354 (Unlimited) · 366 (Standard) |
| Escritura con `fsync`, latencia p50 / p99 | 61 / 4.489 µs | 129 / 2.408 µs | 897 / 1.122 µs |
| Lectura secuencial 1 MiB, MB/s | 1.306,8 | 1.410,6 | 127,3 |
| Red generador → servidor (`iperf3`, 4 flujos, 30 s) | no aplica, el generador está en el mismo equipo | no aplica | 4.953 Mbit/s (Unlimited) · 4.970 Mbit/s (Standard) |

Fuentes: `resultados/20261106_094709_windows_sondas/`, `resultados/20261106_195014_docker_sondas/`, `resultados/ec2_t3small-unl/f0/`, `resultados/ec2_t3small-std/f0/`.

El disco de la t3.small se detiene justo en los límites del volumen. Medimos 3.049 IOPS y 127,3 MB/s, y la página de EBS dice que un volumen gp3 incluye una línea base de 3.000 IOPS y 125 MB/s. El límite lo pone EBS al volumen, no el SSD que hay detrás. Como cada operación viaja por la red del centro de datos, una lectura de 4 KiB tarda 10 ms en p50, contra 0,4 ms en el NVMe del PC. Las dos instancias dieron la misma lectura (3.049 IOPS), lo que es coherente con un límite fijo del volumen.

Hay dos cifras de esta tabla que no se pueden comparar directamente con las demás:

- **Contenedor, lectura aleatoria.** El contenedor lee casi el doble que el PC nativo (79.766 contra 41.903 IOPS) sobre el mismo NVMe. `--direct=1` evita la caché del Linux de la VM, pero el disco de la VM es un archivo dentro de Windows, y Windows puede servir parte de esas lecturas desde su propia caché en RAM. Tomamos esta cifra como cota superior.
- **PC, escritura con `fsync`.** `fio` en Windows usa el motor `windowsaio`. Ese motor reporta 0 µs de `fsync`, así que no midió el vaciado a disco por separado. Las 1.488 IOPS son de escritura completa, pero el tiempo de `fsync` del PC no está medido.

La red de la t3.small llega a unos 5 Gbit/s, y el generador c7i-flex.large está en la misma zona. Las 4.619 retransmisiones en 30 s son normales con 4 flujos TCP que buscan el máximo. En el capítulo 5 comparamos estos techos con lo que usa LobbyLink.

### 2.4 Software

| | PC | Contenedor | t3.small |
| --- | --- | --- | --- |
| JVM | Oracle Java 25 | Eclipse Temurin 21.0.12 (`eclipse-temurin:21-jre`) | Java 21.0.12 |
| MongoDB | 9.0.4 para Windows | 7.0.45 (`mongo:7`) | 7.0.45 (`mongo:7`, red del host) |
| Caché de WiredTiger configurada | 7.287 MB | 256 MB | 440 MB |
| Jar | el mismo en las tres: `jars/disenofinal-base.jar` (30.256.308 bytes) y `jars/disenofinal-nplus1-fix.jar` |||

MongoDB toma para su caché el 50 % de (RAM − 1 GB), con un mínimo de 256 MB. Los valores medidos siguen esa fórmula. En el PC, (15.599 − 1.024) / 2 = 7.287 MB. En la t3.small, (1.905 − 1.024) / 2 = 440 MB. El contenedor solo ve su límite de 1 GB, así que el resultado es 0 y MongoDB usa el mínimo de 256 MB. En las tres opciones, los datos de prueba usan unos 10 MB de caché, así que caben enteros en RAM.

Las versiones no son iguales en las tres opciones. El PC usa otra JVM y otra versión de MongoDB, porque son las que estaban instaladas en el equipo. El contenedor y la t3.small comparten la misma JVM, la misma versión de MongoDB y el mismo sistema (Linux). Por eso la comparación de hardware más limpia es entre esos dos (capítulo 7.2). El capítulo 7.3 mide qué parte de la diferencia del PC se debe a la JVM.

### 2.5 Dónde corre el generador de carga

En AWS, el generador corre en una instancia aparte, una c7i-flex.large (2 vCPU, 4 GiB) en la misma red privada. Así no le quita CPU al servidor medido. En el PC y en el contenedor no tuvimos otra máquina en la red local, así que el generador comparte el equipo. Para que no le quite CPU a lo medido lo fijamos en los hilos 8 a 11. Ningún nivel de carga cuenta como válido si el propio generador se atrasa más de 50 ms en p99 (`genOk`). En Windows ese atraso es de unos 16 ms en p99, que es la resolución del temporizador del sistema. En la c7i-flex.large es de 1,2 a 1,4 ms (`ec2_t3small-unl-nplus1/f6-mezcla-lectura-r1`).

## 3. Método

### 3.1 De dónde sale cada número

Cada número del informe pertenece a una de tres clases, y cada clase se defiende de una forma distinta.

| Clase | Ejemplos | Cómo se defiende |
| --- | --- | --- |
| Medido | ms de CPU por petición, p50/p95/p99, RSS, IOPS, MB/s, KB de red por petición, req/s logradas, resultados de `fio` e `iperf3`, créditos de CloudWatch | Archivo crudo en `resultados/` y el guion que lo produjo |
| Derivado del código o del proyecto | El N+1 de `toSummaryDto`, JWT de 24 h, BCrypt con factor 10, la mezcla `mezcla-postman` | Archivo y línea (capítulo 1.3) o la colección Postman |
| Declarado | El requisito de latencia (p95 ≤ 1.000 ms y errores ≤ 1 %, en `telemetry/profiles/umbrales.json`) y el tamaño de referencia de 200 lobbies (capítulo 1.5) | Para cada uno medimos la sensibilidad: el requisito con 300, 500 y 1.000 ms (3.5) y el tamaño con 100 a 2.000 lobbies (4.2 y 9) |

No usamos ningún nivel de carga supuesto, como "100 usuarios concurrentes". Las tasas que probamos salen de la medición de costo (F1) o son una escala fija igual para las tres opciones (F6).

### 3.2 La cadena de fases

Las fases dependen unas de otras en este orden.

1. F1 mide cuánta CPU gasta cada endpoint cuando no hay contención. Corre un solo cliente que repite el mismo endpoint durante 120 s. D es la CPU que gastó el proceso en ese tiempo, menos la de reposo, dividida entre las peticiones atendidas. Lo expresamos en ms de CPU por petición y lo calculamos por separado para la app y para `mongod`.
2. `telemetry/model.mjs` convierte esos D en un techo predicho. Para una mezcla con fracciones pᵢ, la demanda por petición es Σ pᵢ·Dᵢ, y el techo es X_max = capacidad / Σ pᵢ·Dᵢ. La capacidad son los ms de CPU disponibles por segundo. En el PC son los 8 hilos asignados a app y `mongod`. En el contenedor son 1 CPU para la app y 1 para `mongod`, y el techo lo fija la primera que se llena. En la t3.small son 2 vCPU, o 0,4 en modo Standard sin créditos.
3. F5 comprueba el modelo. Sube la tasa en pasos del 10 % al 150 % del X_max predicho y busca dónde deja de cumplir el requisito. El capítulo 4.5 compara ese codo medido con el predicho.
4. F6 es la comparación entre opciones. Usa la misma escala absoluta (5, 10, 20, 40 y 80 req/s) en las tres máquinas, 600 s por nivel y tres repeticiones con semillas distintas.
5. F7 multiplica por diez el tráfico y, en otra corrida, los datos. Antes de medir escribimos la predicción en un archivo con marca de tiempo.
6. F8 sostiene una carga 40 min o más para ver efectos que solo aparecen con el tiempo: los créditos de la t3 y el crecimiento de la memoria.
7. F7d repite el escenario de datos de F7 con la predicción escrita antes de medir, y lo extiende a cien veces los datos. F9 prueba qué pasa cuando la base no cabe en la caché de WiredTiger. Las dos se agregaron el 2026-11-09 y por ahora solo corrieron en la t3.small con el jar arreglado.

F0 (sondas de disco y red), F2 (costo del listado contra el tamaño de los datos), F3 (Amdahl) y F4 (cuotas del contenedor) explican los resultados, pero no deciden la recomendación.

### 3.3 Cómo generamos la carga

`telemetry/rate.mjs` manda peticiones a una tasa fija λ, contesten o no. Es un modelo abierto. Los usuarios de una API llegan sin esperar a que el servidor termine con los demás. Los tiempos entre llegadas siguen una distribución exponencial (proceso de Poisson) generada con semilla, así que dos corridas con la misma semilla mandan la misma secuencia de peticiones en los mismos instantes.

La latencia se mide desde la hora en que la petición debía salir, no desde que sale. Con un generador de bucle cerrado, si el servidor se atasca, el generador también deja de mandar, y las peticiones que debían salir durante el atasco nunca se miden. Ese error se llama omisión coordinada y hace que el p99 medido salga más bajo que el real. Nuestra primera medición (v1) usaba bucle cerrado, y es una de las razones por las que no comparamos sus números con los de v3.

Tres reglas evitan que un fallo quede fuera de los resultados:

- Una petición que tarda más de 10 s cuenta como error con latencia de 10 s. Por eso, cuando un nivel colapsa, su p95 aparece como 10.181 ms o parecido.
- Si hay más de 4.000 peticiones en vuelo, el generador descarta las nuevas y también las cuenta como error con latencia de 10 s.
- El generador registra su propio retraso al despachar (`genLag`). Si su p99 pasa de 50 ms, el nivel queda marcado `genOk = false` y no lo usamos, porque el que no daba abasto era el generador y no el servidor. En el PC el retraso p99 fue de unos 16 ms y en el generador c7i de 1,2 a 1,4 ms (capítulo 2.5).

Cada nivel tiene un calentamiento (20 o 30 s) que no entra en la medición, para que la JVM compile el código caliente y MongoDB cargue los datos en caché. El generador guarda las latencias en un histograma logarítmico (`telemetry/lib/hist.mjs`) con error máximo de 4 % en cualquier percentil.

### 3.4 Qué mezcla usamos para comparar

Tenemos dos mezclas, las dos sacadas de la colección Postman del proyecto, no de un supuesto de uso.

- `mezcla-postman` llama una vez a cada endpoint del recorrido de la colección: registro, login, crear lobby, listar, ver y unirse. Una de cada seis peticiones crea un lobby, así que durante 600 s a 40 req/s la base pasaría de 200 a unos 4.200 lobbies. Como el listado recorre todos los lobbies, el final de la corrida mediría una aplicación más cara que el principio. La usamos solo en F5, para validar el modelo con una mezcla que incluye escrituras y BCrypt.
- `mezcla-lectura` usa solo las dos lecturas de lobbies de la colección, listar y ver, en partes iguales. No crea datos, así que la carga es la misma del primer al último segundo. Es la mezcla de F6, F7 y F8.

Con `mezcla-lectura` el listado domina el costo. Es una elección conservadora para la recomendación, porque el listado es el endpoint más caro que medimos con el jar base (capítulo 4.1).

### 3.5 Cuándo pasa un nivel y cuánto recomendamos

Un nivel pasa si su p95 es ≤ 1.000 ms y sus errores (5xx, error de red, tiempo vencido o descarte) son ≤ 1 %. El valor de 1.000 ms lo declaramos nosotros. Para saber si la conclusión depende de él, `rate.mjs` evalúa además cada nivel con 300 y 500 ms y guarda el resultado en `passAt`.

Con el jar base, el límite sí cambia cuánto aguanta cada opción. El último nivel que pasa en F6 lo hace con p95 entre 390 y 830 ms. La t3.small Unlimited a 10 req/s tiene p95 de 393, 408 y 408 ms en sus tres repeticiones, y el contenedor a 10 req/s tiene 408, 478 y 425 ms. Con un límite de 300 ms las dos pasarían solo 5 req/s. El PC a 40 req/s tiene p95 de 827 y 629 ms en las dos repeticiones que pasan, así que con 500 ms su máximo sería 20 req/s. Con el jar arreglado ningún nivel de F6 cambia de resultado entre 300, 500 y 1.000 ms, en ninguna de las tres opciones. La recomendación, que usa el jar arreglado, no depende del límite elegido.

Que un nivel pase no basta para recomendar esa carga. Una opción sirve para λ si a esa λ cumple el requisito en F6 y su recurso más usado queda a ≤ 60 % de su capacidad. El 40 % restante es margen para picos de tráfico y para el crecimiento de los datos que mide F2. Entre las opciones que sirven recomendamos la más barata por cada 1.000 peticiones (capítulo 8). La carga base de F7 y F8 (BASE_RPS) es 10 req/s, la mayor λ de la escala en que la t3.small con el jar base cumple esta regla (CPU 48,2 %). La elegimos con el jar base porque F7 y F8 se planearon antes del arreglo, y la mantuvimos con el jar arreglado para comparar los dos con la misma carga.

### 3.6 Qué mide el agente

`telemetry/agent.mjs` corre en la máquina del servidor, fuera de la app, y lee contadores del sistema operativo. Toma una muestra cada 1 s en Linux y Docker, y cada 2 s en Windows, donde lee los contadores de rendimiento con `win-sampler.ps1`. Cada muestra tiene:

- CPU de toda la máquina, separada en Linux en usuario, sistema, `iowait` y `steal` (tiempo que el hipervisor le quita a la VM);
- CPU de la app y de `mongod` en % de un núcleo, su memoria residente (RSS) y su número de hilos;
- IOPS y MB/s de lectura y escritura del disco;
- bytes enviados y recibidos por la red;
- en Docker, el uso y el frenado (`throttled`) de la cuota CFS de cada contenedor, leídos del cgroup;
- de `mongod`, con `serverStatus`, las consultas por segundo, los documentos examinados y los fallos de caché de WiredTiger.

`telemetry/report.mjs` cruza estas muestras con las ventanas de medición de cada nivel en `load.ndjson`, de modo que la CPU o los IOPS de un nivel no incluyen el calentamiento ni la pausa entre niveles.

### 3.7 Fases y valores usados

Todos los valores están en `campanas/campana.sh`, que corre las mismas fases en las tres opciones.

| Fase | Carga | Duración | Valores y su origen |
| --- | --- | --- | --- |
| F0 | Sin app: `fio` (disco) e `iperf3` (red, solo EC2) | Según la sonda | `setup/sondas.sh`. Da el techo del hardware contra el que comparamos el uso |
| F1 | 1 cliente en bucle cerrado, un endpoint por corrida | 120 s, 20 s de calentamiento | 6 endpoints de la colección Postman. 20 usuarios, salvo unirse con 100 (100 × 200 lobbies = 20.000 pares usuario-lobby distintos, para no repetir un par ya unido) |
| F2 | 1 cliente, solo listar | 90 s, 20 s de calentamiento | 100, 200, 400, 800 y 1.600 lobbies: el doble en cada paso, alrededor del tamaño de referencia |
| F3 | Bucle cerrado con 1, 2, 4… hasta el doble de los hilos | 60 s por nivel | Listar y login. No corre en Docker, donde la cuota de 1 CPU no deja nada que escalar |
| F4 | Solo Docker, bucle cerrado con 1, 4 y 16 clientes | 60 s por nivel | Cuotas app × `mongod` de 1×0,5, 1×1, 1×2, 1×4, 2×1 y 4×1 CPU |
| F5 | Tasa fija, 10 % a 150 % del X_max predicho en pasos de 10 % (mínimo 0,5 req/s) | 90 s por nivel, 20 s de pausa | X_max de F1 con `model.mjs`. Se detiene tras 2 niveles fallidos. Las dos mezclas |
| F6 | Tasa fija | 600 s por nivel, 30 s de calentamiento, 60 s de pausa | 5, 10, 20, 40 y 80 req/s en las tres opciones; 3 repeticiones con semillas 1, 2 y 3. Se detiene tras el primer nivel fallido. Además cada opción al 50 % y 80 % de su codo de F5 (`f6-propio`, codo calculado con `knee.mjs`) |
| F7 | Tasa fija | 600 s por nivel | BASE_RPS = 10 y 10 × BASE_RPS = 100 req/s; luego 10 req/s con 2.000 lobbies. Predicción en `resultados/_logs/prediccion_x10_<entorno>_<fecha>.md`, escrita antes de medir |
| F8 | Tasa fija | 2.400 s (Unlimited) y 5.400 s (Standard) | t3.small Unlimited a 10 req/s; Standard a 23 req/s para agotar los créditos en un tiempo medible |
| F7d | Tasa fija, `mezcla-lectura` | 600 s por tamaño | 10 req/s con 2.000 y 20.000 lobbies, jar arreglado. Predicción de `telemetry/prediccion_datos.mjs` con el ajuste de F2 (app y `mongod` por separado) más ver de F1, escrita antes en `_logs/prediccion_datos_<entorno>_<fecha>.md` |
| F9 | Tasa fija, solo ver un lobby al azar | 300 s por nivel | 25, 50, 100, 200 y 400 req/s; se detiene en el primer nivel que falla. Lobbies insertados en bloque (`lib/bulk.mjs`) con ~3 KB de relleno aleatorio y estado cancelado: 20.000 (62 MB, caben) contra 1.000.000 (3.117 MB, no caben en 1,9 GiB) |

### 3.8 Cómo repetir las mediciones

Cada corrida empieza igual. `run.mjs` crea una base de MongoDB nueva (`lobbylink_<etiqueta>_<fecha>`), siembra los datos del capítulo 1.5, arranca la app y el agente, y espera 20 s en reposo. Si en ese reposo la CPU de la máquina pasa de 5 %, la corrida queda marcada como no limpia en `idle.json`. Entre corridas hay 120 s de pausa, y en el PC nunca corren dos a la vez. Cada corrida guarda en `resultados/<fecha>_<entorno>_<etiqueta>/` el registro del generador (`load.ndjson`), el del agente (`agent.ndjson`), el log de la app, la configuración (`run.json`) y el reposo (`idle.json`). Ninguna corrida sobrescribe otra.

Los comandos para repetir la campaña completa son estos (desde `lobbylink_perfv3/`):

```bash
# PC y contenedor (Git Bash como administrador, para fijar mongod a sus hilos)
nohup ./campanas/campana.sh windows,docker > resultados/_logs/_campana.txt 2>&1 &
BASE_RPS=10 FASES="f7" ./campanas/campana.sh windows,docker
# EC2: en el generador, dentro de tmux; luego se traen los datos al PC
./campanas/campana.sh ec2 <IP_PRIVADA_SERVIDOR> t3small-unl
./campanas/recoger_ec2.sh <IP_PUBLICA_GENERADOR> t3small-unl
# El mismo plan con el jar arreglado
./campanas/campana_jar.sh ...
# Tablas
node telemetry/report.mjs resultados/<carpeta> ...
```

Los anexos listan cada carpeta de `resultados/` que usa este informe.

## 4. Resultados por fase

### 4.1 F1, costo por endpoint

Un solo cliente repite cada endpoint durante 120 s. La tabla da D con el jar base, en ms de CPU por petición, como app + `mongod` = total.

| Endpoint | PC | Contenedor | t3.small |
| --- | --- | --- | --- |
| Listar (200 lobbies) | 55,4 + 164,9 = 220,3 | 72,0 + 97,8 = 169,8 | 63,2 + 104,2 = 167,4 |
| Ver un lobby | 2,3 + 2,8 = 5,1 | 3,1 + 2,0 = 5,1 | 2,2 + 2,0 = 4,2 |
| Login | 112,1 + 0,8 = 112,9 | 56,0 + 0,7 = 56,8 | 83,1 + 0,5 = 83,6 |
| Registro | 112,0 + 4,5 = 116,5 | 57,7 + 2,7 = 60,3 | 84,0 + 2,6 = 86,6 |
| Crear lobby | 5,2 + 7,6 = 12,8 | 4,4 + 6,0 = 10,4 | 4,8 + 9,4 = 14,2 |
| Unirse | 3,4 + 7,3 = 10,6 | 3,0 + 5,5 = 8,5 | 3,2 + 9,5 = 12,6 |
| X_max de `mezcla-lectura` (req/s) | 71 | 20 | 23,3 |
| X_max de `mezcla-postman` (req/s) | 100,4 | 30,6 | 32,5 |

Fuentes: `resultados/_logs/modelo_windows_v3-f1.md`, `resultados/_logs/modelo_docker_v3-a1m1-f1.md`, `resultados/ec2_t3small-unl/_logs/modelo_ec2_f1.md`.

Listar cuesta entre 33 y 43 veces lo que cuesta ver un lobby, y `mongod` hace entre el 58 % y el 75 % de ese trabajo. El agente confirma la causa con `serverStatus`. Con `mezcla-lectura` a 10 req/s, `mongod` recibe 103 `find` y 100 conteos por petición. Como solo la mitad de las peticiones lista, cada listado hace unas 206 `find` y 200 conteos, dos consultas por lobby. Cada petición examina además 20.432 documentos en promedio, unos 40.000 por listado. Son los 200 conteos multiplicados por las 200 participaciones que recorre cada uno, porque `participaciones.lobbyId` no tiene índice.

Login y registro gastan el 96-99 % de su CPU en la app. Es BCrypt con factor 10. El mismo login cuesta 112,1 ms en el PC y 56,0 ms en el contenedor, sobre el mismo procesador. El capítulo 7.3 analiza esa diferencia. Crear y unirse cuestan de 8 a 15 ms, y el 58-75 % es de `mongod`, porque escriben.

Con el jar arreglado, listar cuesta 7,2 ms en el PC, 6,9 ms en el contenedor y 7,1 ms en la t3.small: entre 24 y 31 veces menos que con el jar base. La parte de `mongod` baja al 35-47 %. En los demás endpoints el total cambia 2,1 ms o menos. El techo de `mezcla-lectura` sube a 1.288,9 req/s en el PC, 262,3 en el contenedor y 336,5 en la t3.small (archivos `modelo_*_v3fix*` y `ec2_t3small-unl-nplus1/_logs/modelo_ec2_f1.md`).

Una advertencia sobre el PC. En ver, crear, unirse y el listado arreglado, el agente de Windows juntó de 10 a 13 muestras, y el reporte marca como poco fiable cualquier cifra con menos de 30. Son los endpoints baratos, y sus valores coinciden con los del contenedor y la t3.small, que tienen 118-120 muestras.

### 4.2 F2, crecimiento con los datos

F2 mide el listado con un solo cliente, 90 s por tamaño, en bases de 100 a 1.600 lobbies. La tabla da el total de app + `mongod` en ms de CPU por listado.

| Lobbies | PC base | Contenedor base | t3.small base | PC arreglado | Contenedor arreglado | t3.small arreglado |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 101,9 | 84,1 | 81,9 | 4,5 | 5,3 | 4,9 |
| 200 | 201,1 | 170,5 | 171,3 | 8,1 | 6,9 | 7,6 |
| 400 | 421,2 | 365,6 | 374,3 | 12,7 | 9,4 | 10,9 |
| 800 | 895,9 | 797,8 | 884,8 | 16,4 | 13,6 | 17,9 |
| 1.600 | 2.157,4 | 1.895,5 | 2.373,4 | 26,7 | 21,6 | 29,3 |
| Exponente (pendiente log-log) | 1,10 | 1,12 | 1,21 | 0,62 | 0,50 | 0,64 |

Fuentes: `resultados/_logs/datos_*_f2.md` y `datos_ec2_f2.md` en las carpetas `ec2_t3small-unl*`.

Con el jar base, un listado de 1.600 lobbies tarda 2,1 s en el PC y 2,4 s en la t3.small sin ningún otro usuario (p50 de 2.120,7 y 2.385,4 ms). El crecimiento no es igual en los dos procesos. De 800 a 1.600 lobbies, la CPU de la app se multiplica por 2,05 en el PC, que es lo esperable si hace el mismo trabajo por cada lobby. La de `mongod` se multiplica por 2,52 en el PC, 2,57 en el contenedor y 2,92 en la t3.small. La parte que crece más rápido que los datos está en `mongod`.

El código hace N conteos y cada uno recorre las N participaciones, así que examina N² documentos. Esperábamos un exponente cercano a 2 y medimos de 1,10 a 1,21. Un ajuste de dos términos a la CPU de `mongod` en el PC lo explica: unos 0,67 ms por lobby, que es el costo fijo de recibir, planificar y responder dos consultas, más unos 0,26 µs por documento examinado. Con 200 lobbies el término cuadrático es el 7 % de la CPU de `mongod`. Con 1.600 sube al 38 %. Recorrer documentos que están en RAM es barato, así que con estos tamaños domina el costo por consulta. El término cuadrático gana peso con cada duplicación, y por eso F7 colapsa con 2.000 lobbies.

Con el jar arreglado el costo crece menos que los datos (exponente de 0,50 a 0,64). Casi todo el costo es fijo por petición. Lo que crece es armar la respuesta, que pasa de 17,4 KB con 100 lobbies a 275,6 KB con 1.600 y que la app serializa a JSON.

#### Sensibilidad: ¿cambia la recomendación con otro número de lobbies?

Con el costo del listado medido en cada tamaño y el costo de "ver" de F1, calculamos el techo de `mezcla-lectura` en cada opción: X_max = capacidad / Σ pᵢ·Dᵢ. Después aplicamos la regla de recomendación, que deja la máquina al 60 % de ese techo. Las celdas muestran el techo predicho y, después de la flecha, lo que la opción sostiene con la regla, en req/s.

| Lobbies | PC base | Contenedor base | t3.small base | PC arreglado | Contenedor arreglado | t3.small arreglado |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 150 → 89,8 | 41,0 → 24,6 | 46,5 → 27,9 | 1.668 → 1.001 | 301 → 181 | 413 → 248 |
| 200 | 77,6 → 46,6 | 19,9 → 11,9 | 22,8 → 13,7 | 1.204 → 722 | 258 → 155 | 323 → 194 |
| 400 | 37,5 → 22,5 | 8,9 → 5,3 | 10,6 → 6,3 | 894 → 537 | 210 → 126 | 253 → 152 |
| 800 | 17,8 → 10,7 | 3,8 → 2,3 | 4,5 → 2,7 | 741 → 445 | 161 → 96,5 | 176 → 106 |
| 1.600 | 7,4 → 4,4 | 1,5 → 0,9 | 1,7 → 1,0 | 502 → 301 | 110 → 66,2 | 117 → 70,4 |

Fuente: `resultados/_logs/sensibilidad_lobbies_20261107.md`, generado con `telemetry/sensibilidad.mjs` (el comando está al final del archivo).

El orden de las opciones es el mismo en todos los tamaños, y el arreglo es lo que más mueve la capacidad. Con el jar base, la t3.small pasa de sostener 27,9 req/s con 100 lobbies a 1,0 req/s con 1.600, y ni siquiera el PC llega a 5 req/s con 1.600. Con el jar arreglado, la t3.small sostiene 70,4 req/s con 1.600 lobbies, más que el PC con el jar base y 200 lobbies (46,6 req/s). F7 lo confirma con carga real y 2.000 lobbies. El jar base falla en las tres opciones (99,2 % de errores a 10 req/s) y el arreglado pasa en las tres con p95 de 45-62 ms.

Por eso la respuesta a "¿por qué 200 lobbies?" es que la conclusión no depende de ese número.

La tabla tiene un límite. Cada lobby sembrado tiene un solo participante. Si cada lobby tuviera más, la colección `participaciones` crecería, y cada conteo del jar base recorrería más documentos. El jar base quedaría peor que en la tabla. El arreglado cuenta todos los lobbies en una sola agregación, así que le afecta mucho menos.

### 4.3 F3, Amdahl y SMT

F3 sube el número de clientes en bucle cerrado, 60 s por nivel, y mide cuántas veces más rinde la máquina que con un cliente, S(N) = X(N) / X(1). De S(N) despejamos p, la fracción del trabajo que se reparte entre hilos.

| | PC listar | PC login | t3.small listar | t3.small login |
| --- | --- | --- | --- | --- |
| req/s con 1 cliente | 4,9 | 8,9 | 5,7 | 11,9 |
| Mejor req/s (clientes) | 28,8 (8) | 57,7 (16) | 10,2 (4) | 20,9 (4) |
| p (mediana de los puntos) | 0,981 | 0,945 | 0,743 | 0,828 |
| Del núcleo físico al segundo hilo (PC de 4 a 8 clientes, t3 de 1 a 2) | +57 % | +84 % | +59 % | +71 % |

Fuentes: `resultados/_logs/amdahl_windows_v3-f3.md`, `resultados/ec2_t3small-unl/_logs/amdahl_ec2_f3.md`. No corre en el contenedor (capítulo 3.7).

En el PC el listado se reparte casi sin pérdida hasta llenar los 8 hilos. Con 4 clientes S = 3,78 y p = 0,981. Con 8 clientes `mongod` llega a 572 % de un núcleo y la app a 153 %, 7,25 de los 8 hilos. Con 16 clientes el rendimiento baja a 24,8 req/s y el p50 sube de 276 a 654 ms. No quedan hilos libres y los clientes extra solo esperan en la cola. En la t3.small el techo llega con 2 clientes, porque sus 2 vCPU son un solo núcleo. Con 4 clientes `mongod` usa 127 % y la app 67 %, casi las 2 vCPU completas.

El segundo hilo de cada núcleo aporta más de lo que dice la sesión 05 del curso (15-30 %). En login, que es casi todo BCrypt en la app, aporta +84 % en el PC y +71 % en la t3.small. La medición de login es limpia, porque un cliente ya ocupa un hilo entero (98 % de un núcleo en el PC, 102 % en la t3.small). Nuestra explicación es que BCrypt hace muchas lecturas pequeñas y dependientes en tablas que caben en la caché L1, y mientras un hilo espera cada lectura, el otro usa las unidades de ejecución libres. No lo medimos con contadores de hardware. En el listado, el +57 % del PC exagera la ganancia de SMT, porque con 4 clientes los hilos no estaban llenos: cada cliente pasa parte del tiempo esperando a `mongod`.

Con el jar arreglado, el listado en el PC da S(2) = 2,63, más que el número de clientes. Amdahl no aplica a ese caso. Con un cliente cada petición tarda 9 ms y la CPU queda en buena parte ociosa (app 66 % y `mongod` 40 % de un núcleo), porque ese tiempo incluye el viaje por la red local y el trabajo del cliente. El máximo es 1.024,6 req/s con 8 clientes (`amdahl_windows_v3fix-f3.md`). En login el arreglo no cambia nada: +85 % de SMT y 58 req/s de máximo.

Lo que importa para la recomendación es que el trabajo de LobbyLink se reparte bien entre hilos (p de 0,945 a 0,981 en el PC). El límite de la t3.small no es una parte secuencial del código. Es que tiene un solo núcleo físico.

### 4.4 F4, cuotas del contenedor

F4 cambia por separado la cuota de CPU de la app y la de `mongod` y mide `mezcla-lectura` con 1, 4 y 16 clientes. El proceso cuya cuota sube el máximo es el que limita.

| App × `mongod` (CPU) | Jar base, req/s con 16 clientes | Proceso al 100 % | Jar arreglado, req/s con 16 clientes | Proceso al 100 % |
| --- | --- | --- | --- | --- |
| 1 × 0,5 | 9,2 | `mongod` (50 %) | 196,7 | `mongod` (50 %) |
| 1 × 1 | 18,0 | `mongod` | 311,5 | app |
| 1 × 2 | 26,9 | app | 319,0 | app |
| 1 × 4 | 28,6 | app | 319,3 | app |
| 2 × 1 | 17,3 | `mongod` | 410,3 | `mongod` |
| 4 × 1 | 17,8 | `mongod` | 410,5 | `mongod` |

Fuentes: `resultados/_logs/_docker_v3-f4-*.txt`, `_docker_v3fix-f4-*.txt` y las carpetas `*_docker_v3-f4-*` y `*_docker_v3fix-f4-*` (tablas de recursos con `report.mjs`).

Con el jar base, dar más CPU a la app no cambia nada: 18,0 req/s con 1 CPU y 17,8 con 4. `mongod` está al 100 % de su cuota y la app al 65 %. Dar 2 CPU a `mongod` sube el máximo de 18,0 a 26,9 req/s. Ahí la app llega al 100 % de su cuota y pasa a limitar. Por eso 4 CPU para `mongod` casi no suman (28,6 req/s, con `mongod` al 156 %).

Con el jar arreglado pasa al revés. Con 1 CPU cada uno, la app está al 100 % y `mongod` al 78 %. Más CPU para `mongod` no cambia nada (311,5 a 319,3 req/s), y 2 CPU para la app suben el máximo a 410 req/s, hasta que `mongod` llena su CPU. Con 1 CPU para `mongod`, el máximo pasó de 18,0 a 410 req/s, 23 veces más. Es la misma proporción que la caída del D de `mongod` en `mezcla-lectura` entre los dos jars en F1 (de 49,9 a 2,2 ms, 22 veces).

El agente lee el frenado del contenedor de la app en `cpu.stat`. Cuando la app limita, el frenado sube: 5.160 ms/s con el jar base en 1 × 2 y 3.951 ms/s con el jar arreglado en 1 × 1. Pasa de 1.000 ms/s porque el kernel suma el tiempo frenado de cada CPU donde había hilos de la app esperando. Cuando la app no limita (2 × 1 y 4 × 1), el frenado queda en 0-1 ms/s.

Con 16 clientes en bucle cerrado ya hay cola, así que el máximo puede quedar por debajo del de 4 clientes. Con el jar arreglado en 2 × 1, 4 clientes dan 460,4 req/s y 16 dan 410,3.

### 4.5 F5, rampa: predicción contra medición

F5 sube la tasa en pasos del 10 % del X_max predicho por F1, 90 s por nivel, hasta dos niveles fallidos seguidos. La tabla es para `mezcla-lectura`. La utilización es la del recurso que se agota primero según el modelo: los hilos compartidos en el PC y la t3.small, y la cuota de `mongod` (jar base) o de la app (jar arreglado) en el contenedor.

| Opción y jar | X_max predicho | Último λ que pasa (% de X_max) | p95 | Utilización predicha / medida | Primer λ que falla (% de X_max) | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| PC, base | 71 | 35,8 (50 %) | 378 ms | 50 % / 55 % | 42,9 (60 %) | 1.325 ms |
| Contenedor, base | 20 | 10,2 (51 %) | 442 ms | 51 % / 59 % | 12,5 (62 %) | 1.089 ms |
| t3.small, base | 23,3 | 11,8 (51 %) | 425 ms | 51 % / 56 % | 14,5 (62 %) | 1.132 ms |
| PC, arreglado | 1.288,9 | 1.034 (80 %) | 35 ms | 80 % / 70 % | 1.156 (90 %) | 10.181 ms |
| Contenedor, arreglado | 262,3 | 314,3 (120 %) | 65 ms | 120 % / 88 % | 340,8 (130 %) | 9.051 ms |
| t3.small, arreglado | 336,5 | 267,6 (80 %) | 73 ms | 80 % / 82 % | 303,5 (90 %) | 2.902 ms |

Fuentes: `resultados/_logs/validacion_*_f5.md` y `validacion_ec2_f5.md` en `ec2_t3small-unl` y `ec2_t3small-unl-nplus1`.

Con el jar base, la utilización medida sigue a la predicha con 1 a 8 puntos de diferencia, y las req/s logradas igualan a la λ ofrecida hasta el nivel que falla. El modelo describe bien el consumo. Lo que falla antes del 100 % es el requisito de latencia. En las tres opciones el último nivel que pasa está al 50-51 % del techo y el primero que falla al 60-62 %.

Con el jar arreglado el codo llega más tarde, al 80-90 % del techo en el PC y la t3.small. La diferencia está en el tiempo de servicio. Un listado del jar base ocupa la CPU de 150 a 210 ms, así que bastan unas 5 peticiones esperando delante en un recurso que las atiende de a una para pasar de 1 s. Con 7 ms por listado hacen falta unas 140. `mezcla-postman` lo confirma con el jar arreglado: incluye login y registro, que gastan de 56 a 115 ms de BCrypt cada uno, y su último nivel que pasa vuelve a quedar entre el 51 % y el 71 % del techo (90,5 req/s en el PC, 33 en el contenedor y 34,2 en la t3.small).

El contenedor arreglado pasa al 120 % del techo predicho. A 314,3 req/s la app usa el 88 % de su cuota, así que su D bajo carga es de unos 2,8 ms y no los 3,8 ms que midió F1 con un cliente. En el PC arreglado a 1.034 req/s la utilización medida (70 %) también queda por debajo de la predicha (80 %). Con un cliente, F1 sobrestima el costo de las peticiones baratas. Una explicación posible es que bajo carga la JVM y `mongod` reparten costos fijos entre más peticiones, pero no lo medimos.

Con el jar base, `mezcla-postman` falla mucho antes de su techo: en el PC pasa a 19,2 req/s (19 %) con una utilización medida de 38 %, el doble de la predicha. Una de cada seis peticiones crea un lobby, el listado se encarece durante la corrida y D deja de ser constante. Es la razón del capítulo 3.4 para no usar esa mezcla en F6.

### 4.6 F6, carga sostenida (CPU, RSS, IOPS y MB/s, red, p50/p95/p99)

F6 aplica la misma escala a las tres opciones, 600 s por nivel. La tabla da el p95 en ms. Cuando hay más de una repetición, el rango cubre todas.

| λ (req/s) | PC base | Contenedor base | t3.small base | PC arreglado | Contenedor arreglado | t3.small arreglado |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 218-245 | 236-245 | 255-276 | 22 | 23 | 15-16 |
| 10 | 218-236 | 408-478 | 393-408 | 22 | 22 | 12-13 |
| 20 | 236-255 | falla | falla | 21 | 22 | 12-15 |
| 40 | 629 y 827; falla en r3 | | | 21 | 21 | 13-14 |
| 80 | falla | | | 20 | 21 | 16 |

Repeticiones: 3 con el jar base en las tres opciones y con el arreglado en la t3.small, 2 con el arreglado en el PC y el contenedor. Fuentes: `load.txt` de las carpetas `*_f6-mezcla-lectura-r*` y `ec2_t3small-unl*/f6-mezcla-lectura-r*`.

Con el jar base, el contenedor y la t3.small cumplen hasta 10 req/s y el PC hasta 20 (40 en dos de tres repeticiones). Cuando un nivel falla, el colapso es total: a 20 req/s el contenedor responde entre 1,1 y 1,4 req/s y la t3.small entre 1,8 y 2,2, con 89-95 % de errores. Con el jar arreglado las tres opciones pasan los cinco niveles con p95 de 12 a 23 ms y 0 errores. En el PC seguimos la escala con 160 y 320 req/s, y también pasa, con p95 de 17,7 a 19,2 ms.

La tabla siguiente muestra los recursos en el último nivel que pasan las tres opciones con cada jar: 10 req/s con el base y 80 req/s con el arreglado (repetición r1, promedio de las muestras del nivel).

| Métrica | PC base | Contenedor base | t3.small base | PC arreglado | Contenedor arreglado | t3.small arreglado |
| --- | --- | --- | --- | --- | --- | --- |
| p50 / p95 / p99 (ms) | 20,7 / 218 / 245 | 72,7 / 408 / 765 | 22,4 / 393 / 605 | 9,8 / 19,9 / 22,4 | 10,6 / 20,7 / 22,4 | 7,8 / 16,4 / 35,9 |
| CPU de la máquina, promedio / pico | 19,4 % / 76 % | 10,2 % / 17,5 % de la VM | 48,2 % / 99,5 % | 15,7 % / 58 % | 6,6 % / 8,8 % de la VM | 28,8 % / 97,1 % |
| Núcleo (hilo) más ocupado, promedio / pico | 66 % / 100 % | 22 % / 41 % | 50 % / 100 % | 65 % / 100 % | 14 % / 20 % | 30 % / 99 % |
| `us` / `wa` | 8,9 % / no aplica | 5,0 % / 0,0 % | 39,9 % / 0,0 % | 6,0 % / no aplica | 2,9 % / 0,0 % | 23,8 % / 0,0 % |
| `steal`, promedio / pico | no aplica | 0 % / 0 % | 0,5 % / 29,6 % | no aplica | 0 % / 0 % | 1,2 % / 52,7 % |
| CPU app / `mongod` (% de 1 núcleo), promedio | 27 / 77 | 41 / 56 | 34 / 62 | 19 / 22 | 26 / 21 | 33 / 23 |
| CPU app / `mongod` (% de 1 núcleo), pico | 95 / 269 | 74 / 118 | 114 / 136 | 89 / 99 | 35 / 29 | 124 / 71 |
| Frenado de cuota (`throttled`, ms/s), promedio / pico | no aplica | 22 / 543 | no aplica | no aplica | 0 / 39 | no aplica |
| RSS app / `mongod` (MB), promedio | 241 / 96 | 217 / 80 | 260 / 189 | 246 / 132 | 219 / 82 | 250 / 162 |
| RSS app / `mongod` (MB), pico | 252 / 97 | 220 / 81 | 266 / 190 | 247 / 134 | 221 / 83 | 251 / 164 |
| Disco, IOPS / MB/s, promedio | 29 / 1,98 (todo el equipo) | 0 / 0,01 | 1 / 0,01 | 19 / 2,75 (todo el equipo) | 0 / 0,01 | 1 / 0,01 |
| Disco, IOPS / MB/s, pico | 3.200 / 238,6 (todo el equipo) | 16 / 0,12 | 46 / 0,51 | 1.038 / 388,3 (todo el equipo) | 21 / 0,13 | 50 / 0,46 |
| Red de salida (MB/s), promedio | no medible (loopback) | 0,79 | 0,17 | no medible (loopback) | 0,90 a 40 req/s | 1,39 |
| Red de entrada (MB/s), promedio / pico | no medible (loopback) | 0,88 / 2,33 | 0,005 / 0,01 | no medible (loopback) | 1,42 / 2,91 a 40 req/s | 0,037 / 0,052 |
| Documentos examinados por petición | 20.432 | 20.413 | 20.412 | 602 | 602 | 602 |
| Fallos de caché de WiredTiger | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % |

El pico es el mayor valor de una muestra (1 s en Linux, 2 s en Windows) dentro de la ventana del nivel. En el PC el disco es el de todo el equipo, y sus picos son de Windows, no de la app. En el contenedor la red es la interfaz del contenedor de la app, que incluye el tráfico hacia `mongod`. Los picos de la t3.small llegan a 99-100 % de un hilo, pero el promedio sostenido (48,2 % y 28,8 %) es el que usa la regla del 60 %.

(Microbenchmarks de frecuencia y de latencia por nivel de caché del Xeon: `resultados/_microbench_20261108/`, con el código, el script de arranque y la salida cruda. Su análisis está en el capítulo 5 del informe.)

Fuentes: `report.mjs` sobre `20261106_163104_windows_v3-f6-mezcla-lectura-r1`, `20261107_030001_docker_v3-a1m1-f6-mezcla-lectura-r1`, `ec2_t3small-unl/f6-mezcla-lectura-r1`, `20261106_213815_windows_v3fix-f6-mezcla-lectura-r1`, `20261107_074723_docker_v3fix-a1m1-f6-mezcla-lectura-r1` y `ec2_t3small-unl-nplus1/f6-mezcla-lectura-r1`. La red del contenedor sale de `20261107_182137_docker_v3basenet-a1m1-f6-mezcla-lectura-r1` y `20261107_174052_docker_v3fixnet-a1m1-f6-mezcla-lectura-r1`, porque las corridas anteriores del contenedor registraron la red en 0 por un error del agente que ya corregimos.

Cuatro lecturas de esta tabla:

- **El recurso que se usa es la CPU.** En la t3.small con el jar base a 10 req/s, `us` es 39,9 % con `wa` 0,0 %, y `mongod` usa 62 % de un núcleo contra 34 % de la app. El disco hace 1 IOPS en promedio contra las 354 escrituras con `fsync` por segundo que midió F0, y la caché de WiredTiger no tiene fallos. El capítulo 5 desarrolla cada recurso.
- **El arreglo quita trabajo a `mongod`, no a la red ni al disco.** Los documentos examinados por petición bajan de unos 20.400 a 602, y las operaciones de `mongod` a 10 req/s bajan de 1.998 a 54 por segundo. Con 8 veces más tráfico (80 contra 10 req/s), la t3.small arreglada usa 28,8 % de la CPU contra 48,2 % del jar base.
- **La memoria no limita mientras el nivel pasa.** El RSS de la app queda entre 217 y 260 MB y el de `mongod` entre 80 y 189 MB, muy por debajo de 1 GB del contenedor y de 1,9 GB de la t3.small. Solo crece cuando un nivel colapsa, porque las peticiones esperan en memoria: 747 MB en el PC a 80 req/s, 511 MB en la t3.small a 20 req/s y 398 MB en el contenedor a 20 req/s.
- **La red de salida coincide con el tamaño de las respuestas.** `mezcla-lectura` devuelve 17,6 KB por petición en promedio (34,6 KB el listado y 0,6 KB ver). A 80 req/s eso son 1,41 MB/s, y la t3.small midió 1,39 MB/s, el 0,22 % de los 4.953 Mbit/s que dio `iperf3`. En el contenedor la interfaz cuenta además el tráfico entre la app y `mongod`. En el PC todo el tráfico va por loopback y el contador de la tarjeta de red no lo ve.

El p50 de `mezcla-lectura` salta entre unos 20 y unos 160 ms según la repetición (en el PC a 10 req/s es 20,7 ms en r1 y 172,3 ms en r3). La mitad de las peticiones son ver (unos 13 ms) y la otra mitad listar (unos 200 ms), y la mediana cae justo en el borde entre los dos grupos. Por eso comparamos con el p95 y el p99, y `report.mjs` da además la latencia de cada operación por separado.

Las corridas `f6-propio` cargan cada opción al 50 % y al 80 % de su codo en F5, y pasan todas. La única excepción es el contenedor arreglado a 157,1 req/s: el retraso del generador llegó a 78,64 ms en p99, el nivel quedó marcado `genOk = false` y no lo usamos. El nivel siguiente, 251,4 req/s, pasó con p95 de 19,9 ms.

## 5. Dónde espera la aplicación

Una petición puede esperar por CPU, disco, red o memoria. Para cada recurso comparamos lo que usa LobbyLink con lo que la máquina puede dar, medido en F0 o declarado como límite. Los números son de la t3.small con `mezcla-lectura`, salvo que se diga otra cosa, porque es la única opción donde el agente mide `steal` y donde la red va de una máquina a otra.

**CPU.** Es el recurso que se agota. Con el jar base a 10 req/s la máquina está en `us` 39,9 % con `wa` 0,0 % y `steal` 0,5 %. `mongod` usa 62 % de un núcleo y la app 34 %, así que dos tercios de la CPU son de la base de datos. Con un solo cliente, el p50 del listado (153,2 ms) es casi igual a su CPU total (167,4 ms de app y `mongod`). La petición pasa ese tiempo ejecutándose, una consulta tras otra, y no esperando al disco ni a la red. Bajo carga, lo que se suma a ese tiempo es espera en la cola de la CPU. A 20 req/s la máquina llega a 99,9 % y el nivel colapsa. Con el jar arreglado a 80 req/s, `us` baja a 23,8 % con `wa` 0,0 %, y `mongod` usa 23 % de un núcleo contra 33 % de la app. El arreglo cambió qué proceso gasta más, pero el recurso sigue siendo la CPU. En el contenedor la espera tiene otra forma. Cuando un proceso gasta su cuota, el kernel lo frena hasta el siguiente periodo (22 ms/s de frenado en promedio a 10 req/s con el jar base, 3.951 ms/s cuando la app limita en F4).

**CPU que no entrega el hipervisor.** En modo Standard sin créditos, la espera por CPU aparece como `steal`. A 10 req/s el agente midió `steal` 78,8 % y `us` 16,8 %. La instancia pide CPU y el hipervisor le entrega solo la línea base del 20 %. A 2 req/s el `steal` es 0,0 % y el nivel pasa con p95 de 210 ms. A 5 req/s sube a 48,5 % y falla con 52,7 % de errores (carpetas `ec2_t3small-std-thr*`). En Unlimited el `steal` promedio queda entre 0,1 % y 1,2 % en todos los niveles de F6.

**Disco.** No participa. La t3.small hace 1 IOPS en promedio en todos los niveles de F6 y en los 40 minutos de F8, casi todo escrituras (1,0 de escritura contra 0,3 de lectura por segundo en F8 con el jar base), con 0,01 MB/s. Son las escrituras periódicas del journal y los checkpoints de WiredTiger. Frente a lo que midió F0, eso es el 0,03 % de las 3.049 IOPS de lectura y el 0,3 % de las 354 escrituras con `fsync` por segundo. La caché de WiredTiger tiene 0 % de fallos y lee 0 MB/s del disco, porque los datos ocupan unos 10 MB de los 440 MB configurados. El disco por red de EBS, que es unas 27 veces más lento que el NVMe del PC en lectura aleatoria (10.027 contra 375 µs en p50), no afecta a LobbyLink con estos datos. F9 probó qué pasa cuando los datos no caben: con 1.000.000 de lobbies y 400 req/s el disco llega a 365 IOPS, el 12 % de lo que puede dar, y la CPU sigue llenándose primero (capítulo 9.1).

**Red.** Tampoco limita. La salida es 0,17 MB/s a 10 req/s y 1,39 MB/s a 80 req/s, unos 17,4 KB por petición, que es el tamaño medio de las respuestas (34,6 KB el listado de 200 lobbies y 0,6 KB ver). Contra los 4.953 Mbit/s (619 MB/s) que midió `iperf3`, 1,39 MB/s es el 0,22 %. Haría falta multiplicar la tasa por unas 450 para llenar la red, y antes se acabaría la CPU. El tráfico entre la app y `mongod` no sale de la máquina en ninguna opción. Va por loopback o por la red interna de Docker.

**Memoria.** Sobra mientras el nivel pasa. En la t3.small el RSS de la app es 260 MB y el de `mongod` 189 MB a 10 req/s con el jar base, 449 MB de 1.905 MB. La JVM pasa el 0,42 % del tiempo en pausas del GC, sin pausas completas, con 43 MB de heap vivo tras cada GC. En los 40 minutos de F8 el RSS de la app sube de 310 a 324 MB con el jar base y de 237 a 245 MB con el arreglado, y el de `mongod` baja (de 205 a 174 MB y de 165 a 162 MB). No vemos una fuga en ese tiempo. La memoria solo crece cuando un nivel colapsa, porque las peticiones esperan en memoria. La app llega a 511 MB en la t3.small a 20 req/s, con 192 MB de heap vivo y 2,74 % del tiempo en pausas. En el contenedor, con 1 GB de límite, la app llega a 398 MB en el colapso, lejos del límite. En la t3.small Standard, la corrida de F8 que colapsó durante 90 minutos llevó la app de 452 a 721 MB. La memoria sí limita con 20.000 lobbies, aunque la CPU sobre: el listado sin paginar no cabe en el heap de la JVM (capítulo 9.1).

En resumen, LobbyLink espera por CPU y por nada más. Con el jar base la mayor parte de esa CPU la gasta `mongod` en las consultas del N+1. El disco y la red usan menos del 1 % de lo que midió F0, y la memoria menos de un cuarto de la RAM de la t3.small mientras el nivel pasa. Por eso el criterio para elegir máquina es la CPU por dólar, y el capítulo 8 compara sobre esa base.

## 6. Explicación por arquitectura

La causa de fondo es de software: el N+1 de `toSummaryDto` sin índice en `participaciones.lobbyId`. El hardware decide cuánto cuesta esa causa y cuál opción la soporta mejor. La tabla une cada número medido con el componente que lo produce y con el tema del curso que lo explica. Donde el plan de medición (`docs/PLAN.md`) cita una sesión del curso, va su número.

| Número medido | Componente | Por qué ese componente da ese número | Tema del curso |
| --- | --- | --- | --- |
| `us` 39,9 % con `wa` 0,0 % en la t3.small a 10 req/s (jar base); p50 del listado con un cliente (153,2 ms) casi igual a su CPU (167,4 ms) | Núcleos del procesador | La petición pasa su tiempo ejecutando instrucciones. Ningún proceso queda bloqueado esperando al disco | Ley de utilización (U = λ·D) |
| Listar: 167-220 ms de CPU, 58-75 % en `mongod`, unos 40.000 documentos examinados por listado | Núcleos del procesador, usados por `mongod` | Cada una de las ~406 consultas cuesta CPU fija (recibirla, planificarla, serializar la respuesta) y cada conteo recorre las 200 participaciones. El arreglo baja el D de `mongod` en `mezcla-lectura` 22 veces y F4 sube el máximo con 1 CPU para `mongod` 23 veces | Ley de utilización; costo de una instrucción contra costo de una consulta |
| Exponente 1,10-1,21 del listado contra los lobbies; el término cuadrático pasa del 7 % al 38 % de la CPU de `mongod` entre 200 y 1.600 lobbies | Procesador y RAM | Recorrer un documento que está en RAM cuesta unos 0,26 µs, mucho menos que una consulta (unos 0,33 ms por consulta). Con pocos datos domina la cantidad de consultas | Jerarquía de memoria |
| Login +84 % en el PC y +71 % en la t3.small al usar el segundo hilo del núcleo | Núcleo con SMT: dos hilos comparten unidades de ejecución y cachés L1 y L2 | BCrypt deja huecos en el núcleo mientras espera sus lecturas en tablas, y el otro hilo los usa. Es nuestra explicación, sin contadores de hardware | Paralelismo y SMT (sesión 05) |
| p = 0,981 en el PC; la t3.small topa con 2 clientes (S = 1,78 con 4) | Cantidad de núcleos físicos | El trabajo se reparte bien entre hilos, así que el límite de la t3.small es su único núcleo físico, no una parte secuencial | Ley de Amdahl (sesión 05) |
| Login: 56,0 ms de CPU en el contenedor (Ryzen) contra 83,1 ms en la t3.small (Xeon), con la misma JVM, el mismo MongoDB y Linux en los dos | Rendimiento por hilo: frecuencia × instrucciones por ciclo | El mismo código tarda menos en el núcleo Zen 4 que en el Cascade Lake. No medimos la frecuencia durante la prueba (capítulo 7.2) | Rendimiento de la CPU (frecuencia, IPC) |
| Último nivel que pasa al 50-62 % del techo con el jar base y al 80-90 % con el arreglado en el PC y la t3.small (el contenedor arreglado pasa al 120 %) | Cola frente a la CPU | Con 150-210 ms por listado bastan unas 5 peticiones delante para pasar de 1 s; con 7 ms hacen falta unas 140 | Teoría de colas y percentiles (sesión 10) |
| 0 % de fallos en la caché de WiredTiger; datos de unos 10 MB contra 256-7.287 MB de caché | RAM | Todo el conjunto de trabajo está en memoria y ninguna lectura llega al disco | Jerarquía de memoria |
| 1 IOPS promedio contra 3.049 IOPS y 354 escrituras con `fsync` por segundo medidas en F0 | Disco (volumen EBS gp3) | Solo escriben el journal y los checkpoints de WiredTiger. Leer no hace falta porque todo está en RAM | Almacenamiento: IOPS, latencia, `fsync` (sesión 07) |
| EBS: 3.049 IOPS y 127,3 MB/s, p50 de 10.027 µs contra 375 µs del NVMe del PC | Disco por red con límite del proveedor | AWS limita el volumen a 3.000 IOPS y 125 MB/s, y cada operación cruza la red del centro de datos | Almacenamiento (sesión 07) |
| Red: 17,4 KB por petición, 1,39 MB/s a 80 req/s, el 0,22 % de 4.953 Mbit/s | Tarjeta de red y red de AWS | El tráfico es el tamaño de las respuestas. Haría falta unas 450 veces más tasa para llenar el enlace | Entrada y salida: ancho de banda |
| Frenado de la app de 3.951 a 5.160 ms/s cuando su cuota limita; 0-1 ms/s cuando no | Cuota CFS del cgroup | El kernel detiene el contenedor al gastar 100 ms de CPU en un periodo de 100 ms, aunque la VM tenga 12 CPU libres | Virtualización y contenedores |
| `steal` 78,8 % y `us` 16,8 % en la t3.small Standard sin créditos a 10 req/s | Hipervisor de AWS | El hipervisor entrega solo la línea base del 20 % y el resto de la CPU pedida aparece como robada | Virtualización |
| RSS de 449 MB de 1.905 MB y 0,42 % del tiempo en pausas del GC; sube a 511 MB solo en el colapso | Memoria principal | La memoria guarda los objetos de las peticiones en curso. Crece cuando las peticiones se acumulan en la cola, no con el tiempo | Memoria principal |

Tres de estos números explican la recomendación. El primero es `us` 39,9 % con `wa` 0,0 %. LobbyLink necesita CPU y no disco, así que pagar por discos más rápidos no la mejora. El segundo es la caída de 22 veces en el D de `mongod`. El arreglo del N+1 rinde más que cualquier cambio de máquina que medimos. El tercero es p = 0,981 con SMT de +57 % a +84 %. Si algún día hace falta más capacidad, la aplicación aprovecha más núcleos, y la t3.small tiene uno solo.

## 7. Por qué cambian los números entre entornos

X\_max = capacidad / D. Una diferencia entre entornos viene de la capacidad, del costo D de la misma petición, o de la brecha entre lo predicho y lo medido.

### 7.1 Capacidad

| | PC | Contenedor | t3.small |
| --- | --- | --- | --- |
| CPU para app y `mongod` | 8 hilos, 4 núcleos con SMT, compartidos | 1 CPU para la app y 1 para `mongod`, separadas | 2 vCPU, 1 núcleo con SMT, compartidas |
| D de `mezcla-lectura`, jar base (app + `mongod`, ms) | 28,85 + 83,82 = 112,67 | 37,53 + 49,93 = 87,46 | 32,73 + 53,08 = 85,81 |
| X_max, jar base (req/s) | 71 | 20 (limita `mongod`) | 23,3 |
| D de `mezcla-lectura`, jar arreglado (ms) | 3,28 + 2,93 = 6,21 | 3,81 + 2,24 = 6,05 | 3,62 + 2,32 = 5,94 |
| X_max, jar arreglado (req/s) | 1.288,9 | 262,3 (limita la app) | 336,5 |

Fuente: archivos `modelo_*_f1.md` del capítulo 4.1.

El PC tiene 4 veces la CPU de la t3.small, pero cada petición le cuesta un 31 % más (112,67 contra 85,81 ms), así que su techo es 3 veces el de la t3.small y no 4. El contenedor tiene tantas CPU como la t3.small, pero separadas en dos cuotas. Con el jar base, `mongod` llena la suya a 20 req/s mientras la app usa el 75 %. Si las dos CPU fueran compartidas, el techo sería 2.000 / 87,46 = 22,9 req/s. Separar los procesos le cuesta al contenedor un 13 %. Con el jar arreglado limita la app, y la pérdida sube al 21 % (262,3 contra 330 req/s compartidas).

### 7.2 D por hardware (contenedor contra t3.small: misma JVM, mismo sistema, mismo MongoDB)

El contenedor y la t3.small corren la misma versión de Java (21.0.12), el mismo MongoDB (7.0.45) y Linux. Lo que cambia es el procesador (Zen 4 contra Cascade Lake) y la virtualización (Docker sobre Hyper-V contra Nitro). La tabla compara el D de F1 con el jar base.

| Endpoint | Contenedor (ms) | t3.small (ms) | t3.small / contenedor |
| --- | --- | --- | --- |
| Login, app | 56,0 | 83,1 | 1,48 |
| Registro, app | 57,7 | 84,0 | 1,46 |
| Crear lobby, `mongod` | 6,0 | 9,4 | 1,58 |
| Unirse, `mongod` | 5,5 | 9,5 | 1,72 |
| Listar, app | 72,0 | 63,2 | 0,88 |
| Listar, `mongod` | 97,8 | 104,2 | 1,06 |
| Ver, total | 5,1 | 4,2 | 0,82 |
| Listar con el jar arreglado, total | 6,9 | 7,1 | 1,03 |

El trabajo de cálculo puro es un 46-48 % más caro en la t3.small. BCrypt es un bucle de cálculo dentro de la JVM que casi no hace llamadas al sistema, así que mide la velocidad de un hilo: frecuencia por instrucciones por ciclo. La página de T3 da un turbo de hasta 3,1 GHz para el Xeon, y medimos 3,07 GHz sostenidos. No medimos la frecuencia del Ryzen durante la prueba, pero el mismo microbenchmark dentro del contenedor da 4,63 GHz (`resultados/_microbench_docker_20261108/`). El cociente, 1,51, es casi el 1,48 del login, así que la frecuencia alcanza para explicarlo.

El listado cuesta casi lo mismo en las dos opciones, y la app incluso cuesta un 12 % menos en la t3.small. Un listado son unas 406 idas y vueltas entre la app y `mongod`, y cada una pasa por el kernel. En el contenedor ese camino cruza la red virtual de Docker dentro de la VM de Hyper-V. En la t3.small, `mongod` usa la red del host. El agente muestra la diferencia: con el jar base a 10 req/s, el contenedor pasa tanto tiempo en el kernel como en el código (`sy` 5,2 % contra `us` 5,0 %), y la t3.small pasa la sexta parte (`sy` 7,8 % contra `us` 39,9 %). El costo por consulta del contenedor anula la ventaja del Zen 4 en el listado. Es una explicación coherente con esos números, pero no aislamos el costo de la red virtual en una prueba aparte.

### 7.3 D por software (PC nativo contra contenedor: mismo procesador)

En el PC nativo el login cuesta el doble que en el contenedor sobre el mismo Ryzen (112,1 contra 56,0 ms de CPU de la app). El PC usa otra JVM (Java 25) y otro MongoDB (9.0.4), así que probamos si la causa es la JVM. Repetimos F1-login en el PC nativo con Java 25 y con Temurin 21, 1 cliente, 120 s, jar base:

| Corrida | JVM | ms CPU app | p50 (ms) | Muestras |
| --- | --- | --- | --- | --- |
| `20261106_150010_windows_v3-f1-login` (campaña) | Java 25 | 112,06 | 116,4 | 51 |
| `20261107_204909_windows_v3-f1-login-jvm25` | Java 25 | 87,88 | 111,9 | 40 |
| `20261107_205413_windows_v3-f1-login-jvm21` (ver su `NOTA.md`: corrió con Java 25) | Java 25 | 89,04 | 111,9 | 38 |
| `20261107_205738_windows_v3-f1-login-jvm21b` | Temurin 21.0.13 | 104,11 | 111,9 | 40 |
| Docker `20261107_010341_docker_v3-a1m1-f1-login` | Temurin 21.0.12 | 56,00 | 59,8 | 118 |

Comparamos el p50 con un cliente, que es el tiempo de servicio de un login y no depende de restar el reposo. Con Java 21 en Windows es 111,9 ms, igual que con Java 25. En el contenedor, con Java 21 y el mismo procesador, es 59,8 ms. La diferencia sigue a Windows nativo frente a Linux sobre WSL2, no a la versión de Java. Las corridas del 2026-11-07 tienen el reposo sucio (15,5-16 % contra el límite de 5 %) y `mongod` sin fijar, por eso su D varía entre 88 y 104 ms. No medimos la frecuencia del núcleo durante el login en Windows (capítulo 12), así que no sabemos si la causa es el reloj, el plan de energía del portátil u otra parte de Windows.

En el PC el listado también cuesta más (220,3 contra 169,8 ms), pero ahí cambian a la vez el sistema y la versión de MongoDB, y no podemos separar los dos efectos. Por esto la comparación de hardware más limpia es la del capítulo 7.2, y los números del PC sirven para el PC tal como está instalado, no para el Ryzen en general.

### 7.4 Brecha entre predicho y medido (SMT, contención, cola)

El techo X_max cuenta cada hilo o vCPU como una CPU entera y supone que D no cambia con la carga. La tabla lo compara con el máximo que midieron F3 y F4 en bucle cerrado, donde siempre hay peticiones esperando.

| Caso | X_max predicho (req/s) | Máximo medido (req/s, clientes) | Diferencia |
| --- | --- | --- | --- |
| PC, base, solo listar | 36,3 | 28,8 (8) | −21 % |
| t3.small, base, solo listar | 11,9 | 10,2 (4) | −14 % |
| Contenedor 1 × 1, base, `mezcla-lectura` | 20 | 18,0 (16) | −10 % |
| PC, arreglado, solo listar | 1.108,1 | 1.024,6 (8) | −8 % |
| t3.small, arreglado, solo listar | 281,5 | 257,3 (4) | −9 % |
| Contenedor 1 × 1, arreglado, `mezcla-lectura` | 262,3 | 334,4 (4) | +27 % |

Fuentes: `amdahl_*_f3.md` y `_docker_v3*-f4-a1m1.txt`.

Tres efectos explican la brecha.

- **SMT.** El modelo cuenta 8 hilos en el PC como 8 CPU. F3 midió que el segundo hilo de cada núcleo aporta +57 % en el listado, no +100 %. Con esa cifra, el PC equivale a 4 × 1,57 = 6,3 CPU, un 21,5 % menos que 8, y la brecha medida con el jar base es 21 %. En la t3.small la misma cuenta da 1,59 CPU de 2, un 20 % menos, y medimos un 14 % menos. El capítulo 4.3 advierte que el +57 % mezcla SMT con hilos que no estaban llenos, así que la coincidencia del PC indica el orden de magnitud y no es una medición directa de SMT.
- **Contención y cuota.** En el contenedor, `mongod` frena contra su cuota a 18 req/s, un 10 % antes del techo. El reparto de la cuota en periodos de 100 ms deja huecos que no se recuperan.
- **D que baja con la carga.** En el contenedor con el jar arreglado medimos un 27 % más que el techo. F5 muestra la causa (capítulo 4.5): a 314 req/s la app gasta unos 2,8 ms por petición, no los 3,8 ms que midió F1 con un solo cliente.

La brecha que más pesa en la recomendación es la de la cola, no la del techo. Con el jar base el requisito de latencia falla al 50-62 % del techo, mucho antes que cualquiera de estos efectos (capítulo 4.5). Por eso la regla de recomendación deja la máquina al 60 % de uso.

## 8. Comparación

Comparamos las opciones con el jar arreglado, porque es el que recomendamos, y damos también el resultado del jar base. Sumamos dos opciones que no son las tres medidas. La t3.small en modo Standard es la misma instancia con otra política de CPU, y la medimos. La c7a.2xlarge es la instancia de AWS más parecida al PC (Zen 4, 8 núcleos físicos sin SMT, 16 GiB), y solo tiene precio de ficha.

| | PC | Contenedor 1 × 1 | t3.small Unlimited | t3.small Standard | c7a.2xlarge (sin medir) |
| --- | --- | --- | --- | --- | --- |
| Jar base: mayor λ que pasa F6 | 20 req/s (40 en 2 de 3) | 10 req/s | 10 req/s | 10 req/s con créditos; 2 req/s sin créditos | – |
| Jar base: mayor λ con el recurso ≤ 60 % | 20 req/s (a 10 req/s app + `mongod` usan 104 % de un núcleo, 13 % de los 8 hilos; a 20, unos 26 % por proporción) | 10 req/s (`mongod` 56 % de su cuota) | 10 req/s (CPU 48,2 %) | 2 req/s sin créditos | – |
| Jar arreglado: F6 | pasa 80 req/s, y también 160 y 320 | pasa 80 req/s | pasa 80 req/s | pasa hasta 20 req/s, el máximo probado | – |
| Jar arreglado: recurso más usado a 80 req/s | app + `mongod` 41 % de un núcleo, 5 % de los 8 hilos | app 26 % de su cuota | CPU 28,8 % | – | – |
| Qué sobra | CPU, 15 GB de RAM, disco NVMe | 74 % de la cuota de la app, unos 800 MB de memoria por contenedor | 71 % de la CPU, 1,4 GB de RAM, casi todo el disco y la red | Igual que Unlimited mientras haya créditos | – |
| Qué falta | No es un servidor: portátil con Windows, sin redundancia ni IP pública | Corre sobre el PC, así que hereda sus faltas | Un solo núcleo físico; por encima del 20 % de CPU cobra créditos | Sin créditos queda en 0,4 vCPU | – |
| Costo mensual de infraestructura | 129.000-134.000 COP (declarado), 39,84-41,39 USD | 21.500-22.400 COP (1/6 del PC), 6,64-6,92 USD | 16,78 USD hasta 40 req/s; 21,26 USD a 80 req/s | 16,78 USD | 301,31 USD |
| Costo mensual con transferencia a internet | sin cobro por GB (no incluye el plan de internet) | sin cobro por GB (no incluye el plan de internet) | 47,81 USD a 10 req/s; 167,80 a 40; 334,74 a 80 | 47,81 USD a 10 req/s | 614,79 USD a 80 req/s |
| Costo por 1.000 peticiones a 80 req/s | 0,61-0,64 COP (0,00019-0,00020 USD) | 0,10 COP (0,00003 USD) | 0,00010 USD; 0,0016 USD con transferencia | – | 0,0014 USD si sostuviera 80 req/s; 0,0029 USD con transferencia |

Cómo calculamos cada costo:

- **t3.small.** 730 h × 0,0208 USD = 15,18 USD de instancia, más 1,60 USD de 20 GiB de EBS a 0,08 USD/GB-mes, más los créditos excedentes medidos (capítulo 8.1). El precio de EBS es el ejemplo de la página de AWS, que no nombra la región.
- **c7a.2xlarge.** 730 h × 0,41056 USD = 299,71 USD, más el mismo disco. No la medimos.
- **PC.** Depreciación de 4.000.000 COP en 36 meses (111.111 COP al mes; precio y vida útil declarados por nosotros) más energía con el TDP de ficha del procesador, 35 W × 730 h = 25,6 kWh a 700-900 COP/kWh (tarifa supuesta). No medimos la potencia del equipo.
- **Contenedor.** La sexta parte del PC, porque sus cuotas suman 2 de los 12 hilos del equipo.
- **Costo por 1.000 peticiones.** Costo por hora / (req/s × 3.600 / 1.000), como define el plan (`docs/PLAN.md`). A 80 req/s son 288.000 peticiones por hora.

Convertimos el PC y el contenedor a dólares con la TRM oficial vigente el 2026-11-08, 3.237,83 COP por USD (`resultados/_aws_precios_20261108/trm_datos_gov.json`). Sus costos en pesos siguen siendo declarados. El PC y el contenedor no son opciones de despliegue por lo que les falta, no por lo que cuestan (capítulo 11).

La t3.small Standard con el jar arreglado tiene un límite que se puede calcular con los créditos medidos en Unlimited (capítulo 8.1). A 40 req/s la instancia gasta menos de los 24 créditos que gana por hora (pendiente del saldo excedente −5,9), así que sostiene esa carga sin agotarse. A 80 req/s gasta más (pendiente +7,4) y con el tiempo quedaría en la línea base. Interpolando entre los dos niveles, el gasto iguala a la ganancia entre 58 req/s (con la pendiente del saldo) y 67 req/s (con `CPUCreditUsage`, 16,5 créditos/h a 40 req/s y 27,7 a 80). La diferencia viene de que cada nivel cubre de 2 a 5 puntos de CloudWatch.

### 8.1 Costo de la t3.small según la carga: créditos de CPU medidos

La t3.small no entrega sus 2 vCPU completas todo el tiempo. Según la ficha de AWS, gana 24 créditos de CPU por hora, que equivalen a 20 % de cada vCPU (1 crédito = 1 vCPU-minuto). En modo Unlimited puede gastar más de lo que gana, y AWS cobra la diferencia a 0,05 USD por vCPU-hora. Para saber cuánto cuesta de verdad la instancia a cada nivel de carga hay que medir cuántos créditos gasta. No basta con el precio por hora.

CloudWatch registró dos métricas cada 5 minutos durante las corridas. `CPUCreditUsage` cuenta los créditos que se gastaron. `CPUSurplusCreditBalance` es el saldo que se gastó por encima de lo ganado y que AWS cobraría. Con el saldo ganado en 0, la pendiente de ese saldo en créditos por hora ya descuenta los 24 que la instancia gana. Es el cobro adicional por hora si esa carga se mantuviera. `telemetry/creditos.mjs` cruza esas series con la ventana de medición de cada nivel de F6. La salida está en `resultados/_logs/creditos_ec2_unl_20261107.md`.

| Versión | λ (req/s) | CPU de la máquina (agente, F6 r1) | Pendiente del saldo excedente (créditos/h, 3 repeticiones) | Mediana | Créditos excedentes (USD/mes) |
| --- | --- | --- | --- | --- | --- |
| Jar base | 5 | 25,9 % | 7,2 · 10,6 · 4,7 | 7,2 | 4,39 |
| Jar base | 10 | 48,2 % | 31,4 · 27,5 · 33,1 | 31,4 | 19,13 |
| Jar base | 20 | 99,9 % (falla) | 76,9 · 66,2 · 89,9 | 76,9 | 46,79 |
| Arreglado | 10 | 5,3 % | −17,7 · −17,5 · −17,3 | −17,5 | 0 |
| Arreglado | 40 | 14,9 % | −5,9 · −3,8 · −7,2 | −5,9 | 0 |
| Arreglado | 80 | 28,8 % | 6,1 · 7,4 · 9,6 | 7,4 | 4,48 |

Una pendiente negativa indica que la instancia gasta menos de lo que gana: va pagando el saldo y no genera cobro. El cruce entre las dos versiones confirma la línea base de la ficha. El jar arreglado está por debajo de 20 % de CPU hasta 40 req/s (14,9 %) y su pendiente es negativa. A 80 req/s pasa a 28,8 % y la pendiente se vuelve positiva.

Comprobamos el método con la corrida F8, que sostiene 10 req/s durante 40 minutos. Con el jar base la instancia gastó 59,3 créditos por hora. Restando los 24 que gana quedan 35,3, y la pendiente medida del saldo fue 35,3 créditos por hora. Cada nivel de F6 dura 10 minutos y cubre solo de 2 a 5 puntos de CloudWatch, así que sus pendientes varían más entre repeticiones (6,1 a 9,6 créditos/h a 80 req/s).

Con esto, el costo mensual de la t3.small depende de la carga y de la versión del código:

| Versión y carga | Instancia (730 h × 0,0208) | Disco EBS 20 GiB (0,08 USD/GB-mes, por confirmar) | Créditos excedentes | Total USD/mes |
| --- | --- | --- | --- | --- |
| Arreglado, hasta 40 req/s | 15,18 | 1,60 | 0 | 16,78 |
| Arreglado, 80 req/s | 15,18 | 1,60 | 4,48 | 21,26 |
| Jar base, 10 req/s | 15,18 | 1,60 | 19,13 | 35,91 |

Con el código original, servir 10 req/s cuesta más en créditos (19,13 USD) que la instancia misma (15,18 USD). El arreglo del N+1 sirve 8 veces esa carga por 21,26 USD al mes.

**Transferencia a internet.** La tarifa oficial de AWS en us-east-1 es 0,09 USD/GB tras los 100 GB gratis del mes (`resultados/_aws_precios_20261108/precios.md`). Con la salida medida en F6 (mediana de 3 repeticiones), si los clientes están en internet y la carga dura las 730 h:

| Versión y carga | GiB/mes | Transferencia USD/mes | Infraestructura USD/mes | Total USD/mes |
| --- | --- | --- | --- | --- |
| Arreglado, 10 req/s | 445 | 31,03 | 16,78 | 47,81 |
| Arreglado, 40 req/s | 1.778 | 151,02 | 16,78 | 167,80 |
| Arreglado, 80 req/s | 3.583 | 313,48 | 21,26 | 334,74 |
| Jar base, 10 req/s | 446 | 31,11 | 35,91 | 67,02 |

La red no limita el rendimiento, pero a estas cargas domina el costo. Con transferencia, la t3.small supera al PC (39,84-41,39 USD) desde unos 8 req/s sostenidos.

Al terminar la instancia quedaron 104,5 créditos de saldo excedente (22:10 UTC del 6 de noviembre), unos 0,087 USD que AWS cobra al terminar. `CPUSurplusCreditsCharged` se quedó en 0 durante toda la medición porque AWS solo cobra el saldo excedente al terminar la instancia o cuando supera el máximo acumulable.

## 9. Si la carga se multiplica por diez (F7)

F7 corre dos escenarios por opción y por jar. En el de tráfico ×10, la tasa pasa de 10 a 100 req/s con 200 lobbies. En el de datos ×10, la base pasa de 200 a 2.000 lobbies a 10 req/s. Cada nivel dura 600 s.

Antes de cada corrida de tráfico, `campana.sh` escribió la predicción con los D de F1 en `prediccion_x10_<entorno>_<fecha>.md`. Las marcas de tiempo prueban el orden. En el PC los archivos son de las 08:49 y 11:03, hora de Colombia, y las corridas empezaron a las 13:49 y 16:03 UTC, que son las 08:49 y 11:03 locales: la predicción se escribe segundos antes de cada corrida, no horas antes. En el contenedor, 09:28 y 11:41 locales contra 14:28 y 16:41 UTC, con la misma diferencia de zona horaria. En la t3.small, 18:36 y 20:25 UTC contra 18:37 y 20:26 UTC.

| Caso, 100 req/s | Utilización predicha | Medido | p95 y errores |
| --- | --- | --- | --- |
| PC, base | 141 % de los 8 hilos | `mongod` 568 % y app 192 % de un núcleo, el 95 % de los 8 hilos; RSS de la app 730 MB | 10.181 ms, 100 % de errores |
| Contenedor, base | `mongod` 499 % y app 375 % de su cuota | app 97 % y `mongod` 53 % de su cuota; GC completo el 19,5 % del tiempo | 10.181 ms, 100 % de errores |
| t3.small, base | 429 % de las 2 vCPU | CPU 99,9 %; RSS de la app 614 MB | 10.181 ms, 100 % de errores |
| PC, arreglado | 8 % | app 25 % y `mongod` 27 % de un núcleo, el 6,5 % de los 8 hilos | 19,9 ms, 0 errores |
| Contenedor, arreglado | app 38 %, `mongod` 22 % | app 33 %, `mongod` 26 % | 20,7 ms, 0 errores |
| t3.small, arreglado | 30 % | CPU 34 % | 16,4 ms, 0 errores |

Fuentes: `prediccion_x10_*.md` en `resultados/_logs/` y en `ec2_t3small-unl*/_logs/`, `load.txt` de las carpetas `*_f7-trafico-x10` y `ec2_t3small-unl*/f7-trafico-x10`. El p95 de 10.181 ms es el tope del histograma, porque las peticiones agotan el tiempo de espera de 10 s.

La predicción acertó en los seis casos qué opción pasa y cuál no. Con el jar base, las tres necesitaban más CPU de la que tienen, y las tres colapsaron con 100 % de errores. Con el jar arreglado, la utilización medida queda a 1-4 puntos de la predicha en el contenedor y la t3.small, y por debajo en el PC (6,5 % contra 8 %), igual que en F5.

El contenedor con el jar base mostró un límite que el modelo no incluye. Se esperaba que `mongod` frenara primero, pero la app llegó al 97 % de su cuota con `mongod` al 53 %. El agente registró 626 GC completos, el 19,5 % del tiempo en pausas, y el heap lleno (243 de 247 MB). La JVM toma por defecto un cuarto de la memoria visible como heap, unos 256 MB en un contenedor de 1 GB. Con 1 CPU visible usa Serial GC, que para la app entera en cada recolección. Cuando las peticiones se acumulan en la cola, sus objetos llenan el heap y la CPU de la app se va en recolectar. En el contenedor la segunda barrera después de la CPU es el heap de la JVM, no el límite de 1 GB del contenedor. El frenado de la cuota de la app llegó a 5.128 ms/s.

En el escenario de datos ×10 no escribimos la predicción en un archivo antes de medir. La extrapolación de F2 la hicimos después y la damos como tal. Con 1.600 lobbies un listado cuesta de 1,9 a 2,4 s de CPU (capítulo 4.2). Con 2.000 cuesta más, y a 10 req/s la mitad son listados, así que la demanda es de al menos 5 × 1,9 = 9,5 s de CPU por segundo. Eso supera los 8 hilos del PC, las 2 vCPU de la t3.small y la cuota de 1 CPU del contenedor.

| Caso, 2.000 lobbies a 10 req/s | Medido | p95 y errores |
| --- | --- | --- |
| PC, base | `mongod` 636 % y app 139 % de un núcleo; RSS de la app 781 MB | 10.181 ms, 99,18 % de errores (0,08 req/s logradas) |
| Contenedor, base | app 98 % y `mongod` 23 % de su cuota; GC completo el 77,3 % del tiempo, heap 247 de 247 MB | 10.181 ms, 99,18 % de errores |
| t3.small, base | CPU 100 %, `mongod` 158 % de un núcleo; heap 448 de 478 MB, GC 2 % del tiempo | 10.181 ms, 99,18 % de errores |
| PC, arreglado | | p50 24,3 ms, p95 45,4 ms, 0 errores |
| Contenedor, arreglado | | p50 25,2 ms, p95 45,4 ms, 0 errores |
| t3.small, arreglado | | p50 35,9 ms, p95 62,2 ms, 0 errores |

Fuentes: `load.txt` de las carpetas `*_f7-datos-x10` y `ec2_t3small-unl*/f7-datos-x10`. El PC y el contenedor arreglados dan el mismo p95 porque los dos caen en el mismo intervalo del histograma logarítmico.

Con el jar base, diez veces más datos hacen tanto daño como diez veces más tráfico. Las tres opciones responden 0,08 req/s de las 10 pedidas. En el contenedor el heap vuelve a ser la barrera, ahora con el 77,3 % del tiempo en GC completos. La t3.small no muestra ese problema porque su JVM ve 1,9 GB y toma un heap de 478 MB, con 2 vCPU y otro recolector. Con el jar arreglado las tres opciones pasan los dos escenarios. El p95 con 2.000 lobbies es el doble que con 200 (45 a 62 ms contra 20 a 22 ms), porque cada respuesta lleva 10 veces más lobbies.

### 9.1 Datos ×10 y ×100 con predicción previa (F7d) y datos que no caben en memoria (F9)

Estas dos fases corrieron el 2026-11-09 en una t3.small Unlimited nueva, con el jar arreglado y el generador en una c7i-flex.large aparte. Las instancias ya están terminadas.

**F7d.** `telemetry/prediccion_datos.mjs` escribió la predicción a las 17:01:01 UTC, en el mismo segundo en que `_campana_estado.txt` marca el inicio de la primera corrida y antes de sembrar sus datos. Toma el barrido F2 de la t3.small, ajusta D_list(N) = c · N^b por separado para la app (b = 0,646) y para `mongod` (b = 0,636), le suma ver un lobby de F1 (2,76 + 2,02 ms) y predice la utilización a 10 req/s con 50 % de listados.

| Lobbies, 10 req/s | D del listado predicho (app + `mongod`) | Utilización predicha | Medido | p95 y errores |
| --- | --- | --- | --- | --- |
| 2.000 | 21,4 + 11,2 = 32,7 ms | 9 % | CPU 14 % | p50 34,5 ms, p95 59,8 ms, 0 errores |
| 20.000 | 94,8 + 48,6 = 143,4 ms | 37 % | 0 req/s logradas | 10.181 ms (tope del timeout), 100 % de errores |
| 20.000 con `-Xmx1g` | igual | 37 % | Java muerto por el kernel a los 30 s de carga | 100 % de errores (conexión rechazada, p50 1,7 ms) |

Fuentes: `ec2_t3small-pend/_logs/prediccion_datos_ec2_20261109_170101.md`, `ec2_t3small-pend/f7d-datos-2000/`, `ec2_t3small-pend/f7d-datos-20000/` y `ec2_t3small-xmx/f7d-datos-20000/`.

Con 2.000 lobbies la predicción acierta el resultado y se queda corta 5 puntos en la utilización, como en F5. Con 20.000 la predicción de CPU puede ser razonable, pero no importa, porque se acaba otro recurso. La JVM tomó por defecto un heap de 478 MB, un cuarto de la RAM. Con 2.000 lobbies cada listado pesa unos 340 KB de JSON (1,68 MB/s de salida entre unos 5 listados por segundo), así que con 20.000 serían unos 3,4 MB por respuesta, más los objetos que la JVM arma para producirla. `app.log` registra 95 pausas Full GC y 4 `OutOfMemoryError`. Uno de ellos mató el hilo `http-nio-8080-Poller` de Tomcat, el que acepta conexiones, y desde ahí fallaron también las peticiones de ver un lobby. Con `-Xmx1g` el heap deja de ser el tope, pero la máquina no tiene esa memoria: la app llegó a 949 MB residentes con `mongod` en unos 580 MB, y el kernel mató a Java. El modelo de capacidad solo mira CPU, así que no podía prever este fallo. La conclusión es que la t3.small vale mientras la base tenga pocos miles de lobbies abiertos, y antes de 20.000 hay que paginar `GET /api/lobbies`. No medimos esa paginación.

**F9.** Mide cuándo empieza a importar el disco. La carga pide un lobby al azar por su id, porque recorrer la base entera con el listado tardaría minutos por petición. La base que cabe tiene 20.000 lobbies (62 MB). La que no cabe tiene 1.000.000 (3.117 MB de datos y 12,8 MB de índices) contra 1,9 GiB de RAM y 440 MB de caché de WiredTiger.

| 400 req/s | Cabe (20.000) | No cabe (1.000.000) |
| --- | --- | --- |
| Fallos de caché de WiredTiger | 0 % | 12-14 % |
| IOPS del disco | 1 | 365 (12 % de las 3.049 de F0), 12,9 MB/s |
| `wa` y utilización del volumen | 0 % | 3,4 % y 21 % |
| CPU de la máquina | 72 % | 72 % |
| p50 / p95 / p99 | 7,2 / 28,4 / 581 ms | 8,4 / 121 / 1.089 ms |
| Errores | 0 | 0 |

Fuentes: `ec2_t3small-pend/f9-caliente/` y `ec2_t3small-pend/f9-frio/`. Los cinco niveles pasan en las dos bases.

Son 0,9 lecturas de disco por petición. Cada una cuesta unos 10 ms en el EBS (p50 de F0), y eso explica que suba la cola de la latencia y no la mediana: el p50 sube 1,2 ms y el p95 cuatro veces. Aun así el disco trabaja al 12 % de sus IOPS cuando la CPU ya está al 72 %, así que con esta carga el núcleo se llena antes. El caso que F9 no cubre es un recorrido completo de una base que no cabe, como el listado sin filtro sobre millones de lobbies: ahí cada petición leería miles de páginas a 10 ms cada una. El contenedor con `mongod` limitado a 512 MB está pendiente.

## 10. El arreglo del N+1

El arreglo cambia dos métodos de `LobbyServiceImpl` (`LobbyLink_backend_nplus1/`). En lugar de un conteo por lobby, cuenta los participantes de todos los lobbies con una agregación. En lugar de buscar el videojuego de cada lobby, los busca todos juntos con `findAllById`. No agrega índices ni cambia el modelo de datos ni la respuesta de la API. Lo medimos con el mismo protocolo que el jar original, cambiando solo el jar (`--jar`).

| Medida | Jar base | Jar arreglado | Fuente |
| --- | --- | --- | --- |
| D del listado, 200 lobbies (PC / contenedor / t3.small, ms) | 220,3 / 169,8 / 167,4 | 7,2 / 6,9 / 7,1 | F1, capítulo 4.1 |
| Crecimiento con los lobbies (exponente) | 1,10 a 1,21 | 0,50 a 0,64 | F2, capítulo 4.2 |
| X_max de `mezcla-lectura` (PC / contenedor / t3.small, req/s) | 71 / 20 / 23,3 | 1.288,9 / 262,3 / 336,5 | F1, capítulo 7.1 |
| Máximo del contenedor con 1 CPU para `mongod` (F4, req/s) | 18,0 | 410 | F4, capítulo 4.4 |
| Último nivel de F5 que pasa (% del techo) | 50-51 % | 80-120 % | F5, capítulo 4.5 |
| Mayor λ de F6 que pasan las tres opciones | 10 req/s | 80 req/s, el máximo de la escala | F6, capítulo 4.6 |
| Operaciones de `mongod` por segundo a 10 req/s (t3.small) | 1.998 | 54 | F6, capítulo 4.6 |
| Documentos examinados por petición | 20.412 | 602 | F6, capítulo 4.6 |
| Tráfico ×10 y datos ×10 | fallan las tres opciones | pasan las tres opciones | F7, capítulo 9 |
| Créditos excedentes de la t3.small a 10 req/s (USD/mes) | 19,13 | 0 | Capítulo 8.1 |

El arreglo no cambia el hardware que hace falta para un listado. Cambia cuánto trabajo pide cada listado. Con el jar base, un listado de 200 lobbies hace unas 406 consultas a `mongod` (un conteo y una búsqueda por lobby) y examina unos 20.400 documentos. Con el arreglado hace unas pocas consultas en total y examina 602. A 10 req/s, las operaciones de `mongod` bajan de 1.998 a 54 por segundo. La CPU de `mongod` por listado baja 22 veces, y el techo con 1 CPU para `mongod` sube 23 veces.

La consecuencia para la decisión es que ningún cambio de máquina que medimos rinde tanto. Pasar de la t3.small al PC multiplica el techo del jar base por 3 (de 23,3 a 71 req/s). Arreglar el código en la misma t3.small lo multiplica por 14 (de 23,3 a 336,5 req/s). Con el jar base, la opción más barata que pasa 40 req/s es el PC, y la t3.small necesitaría unas 4 veces su capacidad. Con el arreglado, la t3.small pasa 80 req/s al 28,8 % de CPU.

El arreglo también cambia qué limita. Con el jar base limita `mongod` (58-75 % de la CPU del listado). Con el arreglado, la app gasta un poco más que `mongod` en `mezcla-lectura` (3,6 contra 2,3 ms en la t3.small), y en el contenedor la cuota de la app pasa a ser la que se llena primero.

## 11. Recomendación y opción descartada

Recomendamos desplegar LobbyLink con el jar arreglado en una EC2 t3.small en modo Unlimited, con 20 GiB de EBS gp3, en us-east-1. La infraestructura cuesta 16,78 USD al mes hasta 40 req/s y 21,26 USD a 80 req/s, con los créditos medidos en CloudWatch, y con transferencia a internet el total es 47,81 USD a 10 req/s, 167,80 a 40 y 334,74 a 80 (capítulo 8.1). A 80 req/s la CPU queda en 28,8 %, por debajo del 60 % de la regla, con p95 de 16 ms y 0 errores en 3 repeticiones. A 1.000 peticiones cuesta 0,00010 USD, o 0,0016 USD con transferencia. La recomendación vale mientras la base tenga pocos miles de lobbies abiertos: con 2.000 pasa y con 20.000 falla por memoria (capítulo 9.1), así que antes de llegar a ese tamaño hay que paginar `GET /api/lobbies`.

Si hubiera que desplegar el código original, la recomendación sería la misma instancia, pero solo hasta 10 req/s (CPU 48,2 %), por 35,91 USD al mes (67,02 USD con transferencia). Más de la mitad de la infraestructura son créditos. Antes de pagar una máquina más grande para el código original, conviene aplicar el arreglo.

Descartamos las otras opciones por lo siguiente.

- **t3.small Standard.** Es la misma instancia sin cobro de créditos. Con el jar base y sin créditos, la línea base del 20 % solo alcanza para 2 req/s (a 10 req/s el `steal` llega a 78,8 %). Con el jar arreglado alcanza hasta unos 58-67 req/s, y por encima gasta el saldo hasta caer en la línea base. Unlimited cuesta lo mismo hasta 40 req/s y no tiene ese riesgo.
- **PC.** Tiene la mayor capacidad medida (pasa 320 req/s con el jar arreglado y 20 req/s con el base), pero es un portátil con Windows. No tiene IP pública ni redundancia de energía o de disco, y el generador de carga corría en la misma máquina. Además su costo depende de supuestos nuestros (precio, vida útil, tarifa de energía). No lo descartamos por precio: cuesta 39,84-41,39 USD al mes, menos que la t3.small con transferencia desde unos 8 req/s sostenidos.
- **Contenedor 1 × 1.** Pasa la misma carga que la t3.small, pero corre dentro de Docker Desktop sobre el PC, así que hereda lo que le falta al PC. Sirvió para medir cuotas y para encontrar el límite del heap de la JVM. Para desplegarlo en un servidor real habría que fijar el heap con `-Xmx` en proporción al límite del contenedor (capítulo 9).
- **c7a.2xlarge.** Es la instancia de AWS más parecida al PC. Cuesta 301,31 USD al mes, 18 veces la t3.small en infraestructura (1,8 veces a 80 req/s con transferencia, 614,79 contra 334,74 USD), y LobbyLink arreglado no necesita esa capacidad. No la medimos.

Las cuatro preguntas de la sustentación tienen esta respuesta corta.

1. **¿Qué limita a LobbyLink?** La CPU. En la t3.small con el jar base a 10 req/s, `us` es 39,9 % con `wa` 0,0 %, el disco hace 1 IOPS contra las 354 escrituras con `fsync` por segundo medidas en F0 y la red usa el 0,03 % de lo que midió `iperf3`. Dos tercios de esa CPU los gasta `mongod` en las consultas del N+1.
2. **¿Qué opción conviene?** La t3.small Unlimited con el jar arreglado, por 16,78 a 21,26 USD al mes de infraestructura hasta 80 req/s, o de 47,81 a 334,74 USD con transferencia a internet entre 10 y 80 req/s.
3. **¿Qué pasa si la carga se multiplica por diez?** Con el jar base, las tres opciones colapsan con tráfico ×10 y con datos ×10, como predijo F1. Con el arreglado, la t3.small atiende 100 req/s con 34 % de CPU y 2.000 lobbies con p95 de 62 ms. Con cien veces los datos, 20.000 lobbies, se rompe la memoria de la JVM y no la CPU.
4. **¿Qué parte del hardware explica cada resultado?** El capítulo 6 relaciona cada número medido con su componente: el núcleo con SMT, la cuota CFS, la línea base de créditos, la caché de WiredTiger y el heap de la JVM.

## 12. Limitaciones

Estas son las condiciones que pueden cambiar algún número del informe y cómo lo afectan.

**Entornos.**

- En el PC y el contenedor, el generador de carga corre en la misma máquina. Fijamos la afinidad (hilos 8 a 11 para el generador), pero comparte memoria, caché L3 y controlador de memoria con la app. En la t3.small el generador corre en otra instancia.
- El PC usa Java 25 y MongoDB 9.0.4. El contenedor y la t3.small usan Java 21 y MongoDB 7.0.45. Comparamos el PC con el contenedor sabiendo que cambian el sistema y las versiones a la vez (capítulo 7.3).
- Docker corre en la VM de WSL2, no en un Linux nativo. Su red virtual y sus llamadas al sistema cuestan más que en Linux sobre hardware propio (capítulo 7.2).
- No medimos la frecuencia del Ryzen durante las pruebas. Sí la medimos aparte dentro del contenedor (4,63 GHz, capítulo 7.2). Para medirla durante las pruebas haría falta registrar el contador `% Processor Performance` de Windows mientras corre F1. Sin ese dato no sabemos si el doble costo del login en Windows nativo viene del reloj.
- Medimos un solo tipo de instancia de nube. La c7a.2xlarge solo tiene precio de ficha.

**Medición.**

- En el PC, los endpoints baratos de F1 tienen de 10 a 13 muestras con un cliente, por debajo de las 30 que pide el modelo (capítulo 4.1). Sus D son menos fiables que los del listado y el login.
- Las tres corridas de la prueba de JVM del capítulo 7.3 tuvieron el reposo sucio (15,5-16 %) y `mongod` sin fijar.
- F6 con el jar arreglado tiene 2 repeticiones en el PC y el contenedor, y 3 en las demás.
- Las corridas del contenedor anteriores al 2026-11-07 registraron la red en 0 por un error del agente. Repetimos un nivel de F6 de cada jar con el agente corregido.
- No medimos la explicación de SMT y BCrypt con contadores de hardware (capítulo 4.3).
- Las pendientes de créditos de la t3.small salen de 2 a 5 puntos de CloudWatch por nivel (capítulo 8.1).
- La predicción de datos ×10 de F7 la extrapolamos después de medir (capítulo 9). F7d la repitió con la predicción escrita antes, pero por ahora solo en la t3.small (capítulo 9.1).

**Carga y datos.**

- `mezcla-lectura` no incluye escrituras ni BCrypt. `mezcla-postman` sí, y su codo queda al 51-71 % del techo (capítulo 4.5).
- Cada lobby sembrado tiene un participante, y 200 lobbies es un tamaño que declaramos nosotros. El capítulo 4.2 muestra que la recomendación no cambia entre 100 y 1.600 lobbies.
- En F1 a F8 los datos cupieron en la caché de WiredTiger (0 % de fallos). F9 probó una base que no cabe, pero solo en la t3.small y pidiendo un lobby a la vez. Ahí el disco no limitó. Un recorrido completo de una base que no cabe sí dependería de los 10 ms por lectura del EBS (capítulo 9.1).
- El listado no tiene paginación, y con 20.000 lobbies la t3.small se queda sin memoria. No medimos una versión paginada.

**Costos.**

- El precio de EBS (0,08 USD/GB-mes) es el ejemplo de la página de AWS, que no nombra la región.
- El costo del PC usa un precio, una vida útil y una tarifa de energía declarados por nosotros, y la potencia es el TDP de ficha (35 W). No medimos la potencia con un vatímetro. Lo convertimos a dólares con la TRM del 2026-11-08.
- La transferencia a internet supone que toda la salida medida sale de AWS durante las 730 h, sin compresión ni CDN.

**Código.** El arreglo del N+1 es nuestro, no del autor de LobbyLink. Lo probamos con F1 a F8 y con la colección de Postman, pero no con las pruebas del proyecto, porque `src/test` está vacío. Además `telemetry/comparar_respuestas.mjs` arrancó los dos jars sobre la misma base y comparó 95 respuestas (listados completos, listados filtrados por videojuego y detalles de 45 lobbies con 0 a 5 cupos libres, 13 de ellos llenos). Las 95 fueron idénticas campo por campo en la t3.small el 2026-11-09 (`resultados/_equivalencia_20261109_ec2/`).

## Anexos

### A. Carpetas crudas por capítulo

Todas las rutas son relativas a `lobbylink_perfv3/resultados/`. Cada corrida tiene `load.ndjson`, `agent.ndjson`, `app.log`, `run.json`, `idle.json` y `load.txt`.

| Capítulo | Carpetas y archivos |
| --- | --- |
| 2, F0 | `_logs/_windows_f0.txt`, `_logs/_docker_f0.txt`, `ec2_t3small-unl/f0/` |
| 4.1, F1 | `_logs/modelo_*_f1.md`, `ec2_*/_logs/modelo_ec2_f1.md`, carpetas `*_f1-*` |
| 4.2, F2 | `_logs/datos_*_f2.md`, `_logs/sensibilidad_lobbies_20261107.md`, carpetas `*_f2-*` |
| 4.3, F3 | `_logs/amdahl_windows_v3*-f3.md`, `ec2_t3small-unl*/_logs/amdahl_ec2_f3.md` |
| 4.4, F4 | `_logs/_docker_v3*-f4-*.txt`, carpetas `*_docker_v3*-f4-*` |
| 4.5, F5 | `_logs/validacion_*_f5.md`, `ec2_t3small-unl*/_logs/validacion_ec2_f5.md` |
| 4.6, F6 | carpetas `*_f6-mezcla-lectura-r*`, `*_f6-propio`, `*_docker_v3basenet-*`, `*_docker_v3fixnet-*`, `ec2_t3small-unl*/f6-*` |
| 5, Standard | `ec2_t3small-std*`, `_logs/prediccion_std_throttled_20261106_152620.md`, `_logs/prediccion_f8_std_20261106_133637.md` |
| 7.3, JVM | `20261107_204909_windows_v3-f1-login-jvm25`, `20261107_205413_windows_v3-f1-login-jvm21`, `20261107_205738_windows_v3-f1-login-jvm21b` |
| 8, costos | `_aws_precios_20261107/precios.md`, `_aws_costos_20261106/`, `_aws_costos_20261107/costos_consola.md`, `_logs/creditos_ec2_unl_20261107.md` |
| 9, F7 | `_logs/prediccion_x10_*.md`, carpetas `*_f7-*`, `ec2_t3small-unl*/f7-*`, `ec2_t3small-unl*/_logs/prediccion_x10_ec2_*.md` |
| 5 y 8.1, F8 | `ec2_t3small-unl/f8-largo`, `ec2_t3small-unl-nplus1/f8-largo` y las carpetas `f8*` de `ec2_t3small-std*` |
| 9.1, F7d y F9 | `ec2_t3small-pend/` (`f7d-datos-2000`, `f7d-datos-20000`, `f9-caliente`, `f9-frio`, `_logs/prediccion_datos_ec2_20261109_170101.md`), `ec2_t3small-xmx/f7d-datos-20000` |
| 12, equivalencia | `_equivalencia_20261109_ec2/` |

### B. Comandos para reproducir

Desde `lobbylink_perfv3/`. Los dos jars están en `jars/` (`disenofinal-base.jar` y `disenofinal-nplus1-fix.jar`).

```bash
# Campaña completa en el PC y el contenedor, jar base (terminal de administrador para fijar mongod)
nohup ./campanas/campana.sh windows,docker > resultados/_logs/_campana.txt 2>&1 &
# La misma campaña con el jar arreglado
JAR='C:/ruta/a/lobbylink_perfv3/jars/disenofinal-nplus1-fix.jar' ./campanas/campana_jar.sh windows,docker
# Solo F7, con la carga base de 10 req/s
BASE_RPS=10 FASES="f7" ./campanas/campana.sh windows,docker
# En la nube: en el generador, dentro de tmux
./campanas/campana.sh ec2 <IP_PRIVADA_SERVIDOR> <etiqueta>
# y después, en el PC, traer los resultados
./campanas/recoger_ec2.sh <IP_PUBLICA_GENERADOR> <etiqueta> [llave.pem]
# F9 y F7d en la nube (en el generador; el servidor debe tener el jar arreglado, ver setup/EC2.md)
FASES="f9 f7d" ./campanas/campana.sh ec2 <IP_PRIVADA_SERVIDOR> <etiqueta>
# Regenerar las tablas de una corrida
node telemetry/report.mjs resultados/<carpeta>
```

La preparación de la instancia y del generador está en `setup/`, y el orden de las fases y sus parámetros en `docs/PLAN.md`.

### C. Tablas de modelo y validación

`resultados/_logs/` guarda las tablas que generan `telemetry/model.mjs` (F1), `telemetry/amdahl.mjs` (F3), `telemetry/knee.mjs` (F5), `telemetry/creditos.mjs` (créditos) y `telemetry/sensibilidad.mjs` (F2). Las de la t3.small están en `ec2_t3small-*/_logs/`. `_campana_estado.txt` registra la hora de cada paso de las campañas locales, y `_campana_estado_completo_f7f8.txt` la de la t3.small.

### D. Dashboard

`dashboard/index.html` muestra todas las corridas con sus series de CPU, memoria, disco, red y latencia. `dashboard/visor.html` abre una corrida a la vez. `node dashboard/build.mjs` regenera `dashboard/data.js` a partir de `resultados/`.

### E. Costos de AWS

`resultados/_aws_precios_20261107/precios.md` tiene los precios de ficha con la fecha de consulta: t3.small, c7a.2xlarge, EBS y créditos de CPU. `resultados/_aws_costos_20261107/costos_consola.md` tiene lo que cobró AWS por las instancias usadas en la medición, que ya están terminadas.
