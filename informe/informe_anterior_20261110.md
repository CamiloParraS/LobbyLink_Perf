# LobbyLink: en qué máquina debe correr

Arquitectura Computacional, UCC, proyecto final. Todas las cifras salen de nuestras corridas en `lobbylink_perfv3/resultados/`. El anexo técnico, `anexo_tecnico.md`, tiene el detalle de cada fase, las tablas completas y la ruta de cada carpeta cruda. Las referencias "anexo, cap. X" apuntan a ese documento.

## 1. Introducción

### Qué hicimos

El enunciado pregunta en qué máquina debería correr una aplicación real y con qué datos se sostiene esa decisión. Tomamos LobbyLink, le generamos carga sostenida de forma repetible y la medimos en tres opciones. La primera es el PC de un integrante, la segunda un contenedor Docker con límites que fijamos nosotros y la tercera una instancia EC2 t3.small de AWS. En cada una medimos la CPU con su promedio, su pico y su valor por núcleo, la memoria residente, las IOPS y los MB/s de disco, la red de entrada y de salida, y la latencia p50, p95 y p99.

Al medir encontramos que el costo de la aplicación se concentra en un solo endpoint, por un defecto del código conocido como consultas N+1. Lo corregimos sin tocar la base de datos y repetimos todas las mediciones con el código corregido. El informe compara entonces las tres máquinas dos veces, con el código original y con el corregido, y muestra qué pesa más en la decisión.

### El repositorio

LobbyLink es el backend de una aplicación para organizar partidas. Un usuario publica un lobby para un videojuego y otros se unen hasta llenarlo. Jeferson Morillo lo escribió para Diseño de Software. Lo elegimos porque arranca en nuestras máquinas solo con MongoDB y podemos cargarlo sin depender de nadie.

El trabajo está repartido en cuatro carpetas:

- `LobbyLink_backend/` es la aplicación original. Es una API REST en Spring Boot 3.5.14 con 23 endpoints en 7 controladores. Los controladores llaman a servicios, los servicios a repositorios, y los repositorios hablan con MongoDB por medio de Spring Data. La autenticación es JWT sin estado y las contraseñas se guardan con BCrypt de factor 10. El proyecto trae una colección Postman con el recorrido de uso que documenta su autor.
- `LobbyLink_backend_nplus1/` es nuestra copia con el arreglo del listado, que describe la sección 5. Su jar es `jars/disenofinal-nplus1-fix.jar`, y el del código original es `jars/disenofinal-base.jar`. Medimos los dos con el mismo protocolo y cambiamos solo el jar.
- `lobbylink_perfv3/telemetry/` tiene las herramientas de medición. `rate.mjs` genera carga a tasa fija y `load.mjs` en bucle cerrado. `agent.mjs` es el agente de telemetría y corre fuera de la app. `model.mjs` calcula el modelo de capacidad y `report.mjs` arma las tablas. `campanas/campana.sh` corre todas las fases en las tres opciones.
- `lobbylink_perfv3/resultados/` guarda una carpeta por corrida. Cada una tiene el registro del generador en `load.ndjson`, el del agente en `agent.ndjson`, el log de la app, la configuración en `run.json` y el reposo previo en `idle.json`. Ninguna corrida sobrescribe otra.

Al leer el código vimos dónde está el costo. `GET /api/lobbies`, en `LobbyServiceImpl.listLobbies`, devuelve todos los lobbies abiertos sin paginar. Por cada lobby hace dos consultas más, una que cuenta sus participantes con `countByLobbyId` y otra que busca su videojuego con `findById`. Con 200 lobbies son unas 406 consultas por petición, y `participaciones.lobbyId` no tiene índice. El otro punto caro es el login y el registro, porque BCrypt hace 2¹⁰ rondas de cálculo dentro de la JVM.

### Las cargas preparadas

Cada corrida crea una base nueva con 1 videojuego, 20 usuarios y 200 lobbies de un participante. Empezamos siempre de cero porque el listado recorre todos los lobbies, y con una base acumulada cada corrida mediría otra aplicación. Los 200 lobbies son un tamaño que elegimos nosotros, así que también medimos con 100 a 2.000 lobbies.

**Cómo llegan las peticiones.** Para la carga sostenida usamos `rate.mjs`, que manda peticiones a una tasa fija λ, medida en peticiones por segundo o req/s. El generador manda cada petición a su hora, conteste o no el servidor. Reparte las llegadas con un proceso de Poisson de semilla fija, de modo que llegan al azar con promedio λ y la misma semilla repite la misma secuencia. Así llegan los usuarios de una API, que no esperan a que el servidor termine con los demás. El generador mide la latencia desde la hora en que cada petición debía salir, así que un atasco del servidor queda en la medición. Una petición que tarda más de 10 s cuenta como error. Si el propio generador se atrasa más de 50 ms en p99, el nivel no cuenta.

**Qué peticiones se mandan.** Las dos mezclas salen de la colección Postman del proyecto.

- `mezcla-lectura` manda 50 % de listados con `GET /api/lobbies` y 50 % de consultas de un lobby con `GET /api/lobbies/{id}`. No crea datos, así que la carga es la misma del primer al último segundo. Es la mezcla con la que comparamos las máquinas.
- `mezcla-postman` manda los seis endpoints de la colección en partes iguales, un sexto de registro, login, crear lobby, listar, ver y unirse. Crea un lobby cada seis peticiones, así que el listado se encarece durante la corrida. La usamos solo para validar el modelo en la rampa.

**Cuánto y cuánto tiempo.** Las tasas no son supuestas. Salen de una cadena de fases en la que cada una usa lo que midió la anterior. F1 mide cuánto cuesta cada petición, el modelo convierte ese costo en un techo predicho, F5 comprueba el techo con una rampa y F6 compara las máquinas con una escala común. `campanas/campana.sh` corre las fases en ese orden y con los mismos parámetros en las tres opciones.

**F0, techo del hardware.** Antes de cargar la app medimos cuánto puede dar el hardware, para comparar después el uso de LobbyLink con un máximo medido y no con la ficha técnica. `fio` corre tres pruebas de 60 s sobre un archivo de 1 GiB y evita la caché del sistema operativo, así que mide el disco y no la RAM.

- La primera lee bloques de 4 KiB al azar con 32 peticiones en vuelo y da las IOPS máximas.
- La segunda escribe bloques de 4 KiB de uno en uno y hace `fsync` después de cada uno, que es lo que hace una base de datos al confirmar una escritura.
- La tercera lee en secuencia bloques de 1 MiB con 8 en vuelo y da los MB/s.

En el contenedor, `fio` corre dentro de un contenedor con la misma cuota de CPU que `mongod`. En la nube corre en la t3.small sobre el volumen EBS. `iperf3` mide la red entre el generador y el servidor durante 30 s con 4 conexiones en paralelo. Esa medición solo existe en AWS, porque en el PC y en el contenedor el generador y el servidor están en la misma máquina.

**F1, costo por petición.** Responde cuánto cuesta cada endpoint por sí solo. Un único cliente en bucle cerrado manda una petición, espera la respuesta y manda la siguiente, así que nunca hay cola. Lo repetimos para los seis endpoints de la colección Postman: listar, ver un lobby, login, registro, crear lobby y unirse. Cada corrida dura 120 s después de 20 s de calentamiento, que le dan tiempo a la JVM de compilar el código más usado.

- **Siembra.** Se siembran 20 usuarios para todos los endpoints. Para unirse se siembran 100, porque 100 usuarios por 200 lobbies dan 20.000 pares distintos y ninguna petición repite un par que ya se unió.
- **Qué da.** De cada corrida sale D, los milisegundos de CPU por petición, separados entre la app y `mongod`. Es la CPU media del proceso menos la que usaba en reposo, dividida entre las peticiones por segundo. También salen las lecturas de disco y los bytes de red por petición.
- **El modelo.** Con D, `model.mjs` aplica la ley de utilización, U = λ·D. El recurso con mayor D llega primero al 100 %, y la tasa a la que llega es el techo predicho, X_max.

**F2, crecimiento con los datos.** Responde cómo sube el costo del listado cuando hay más lobbies. Es la corrida de F1 para el listado, repetida con bases de 100, 200, 400, 800 y 1.600 lobbies y 90 s por tamaño. Ajustamos el costo como una potencia del número de lobbies. Un exponente de 1 significa que el costo crece en la misma proporción que los datos, y uno mayor que crece más rápido. Con ese ajuste se predice qué pasa con diez veces más datos.

**F3, paralelismo.** Responde cuánto gana la app con más núcleos. Corre en bucle cerrado con cada vez más clientes, desde 1 hasta el doble de los hilos de la máquina, pasando por el número de núcleos físicos y el de hilos. Cada nivel dura 60 s. Usamos dos cargas que ocupan partes distintas del sistema. El listado reparte el trabajo entre la app y `mongod`, y el login es BCrypt dentro de la JVM.

- `amdahl.mjs` ajusta la ley de Amdahl a la curva de rendimiento y da la fracción paralela p.
- Compara el rendimiento con tantos clientes como núcleos y con tantos como hilos. La diferencia es la ganancia de SMT, el segundo hilo de cada núcleo.
- No corre en el contenedor, porque con 1 CPU no hay núcleos que sumar.

**F4, cuotas del contenedor.** Responde cuál de los dos contenedores limita. Solo corre en Docker. Probamos seis repartos de CPU entre la app y `mongod`. En cuatro la app tiene 1 CPU y `mongod` recibe 0,5, 1, 2 o 4. En los otros dos `mongod` tiene 1 y la app recibe 2 o 4. Cada reparto corre con `mezcla-lectura` y con 1, 4 y 16 clientes en bucle cerrado, durante 60 s por nivel. Si darle más CPU a un contenedor no sube el rendimiento, ese contenedor no era el cuello de botella. El agente también cuenta cuántas veces el kernel frenó cada contenedor por agotar su cuota.

**F5, rampa.** Responde si el modelo de F1 acierta. Parte del X_max predicho y sube la tasa del 10 % al 150 % de ese valor en pasos de 10 %. Cada nivel dura 90 s, con 20 s de calentamiento y 20 s de pausa. La rampa se corta después de dos niveles seguidos que no pasan, y corre una vez con cada mezcla. Comparamos el codo medido, que es la tasa en la que el p95 empieza a subir, con el predicho. Si coinciden, el modelo explica la máquina. Si no, hay un recurso que el modelo no está viendo.

**F6, carga sostenida y comparación.** Responde la pregunta central: con el mismo tráfico, cómo le va a cada máquina. Las tres opciones reciben la misma escala absoluta de 5, 10, 20, 40 y 80 req/s con `mezcla-lectura`, para que una tasa dada signifique lo mismo en las tres.

- **Duración.** Cada nivel dura 600 s, con 30 s de calentamiento y 60 s de pausa para que se vacíe la cola del nivel anterior. La corrida termina en el primer nivel que falla, porque los siguientes también fallarían.
- **Repeticiones.** Cada opción corre tres repeticiones con las semillas 1, 2 y 3, que dan la variación entre corridas. Una repetición completa dura unos 58 minutos. Con el código corregido, el PC siguió con 160 y 320 req/s, porque a 80 todavía le sobraba casi toda la CPU.
- **Nivel propio.** En el PC y en el contenedor hay una corrida más al 50 % y al 80 % del codo que midió F5 en esa misma máquina. Muestra qué le sobra a cada una cuando está holgada y cuando está casi llena.

De F6 salen todas las métricas de la tabla de resultados.

**F7, carga multiplicada por diez.** Responde qué pasaría si la carga se multiplicara por diez, como pide el enunciado. Toma como base 10 req/s, que las tres opciones pasan con el código original.

- **Tráfico por diez.** En una misma corrida, la tasa pasa de 10 a 100 req/s con 200 lobbies, 600 s en cada nivel.
- **Datos por diez.** La tasa se queda en 10 req/s, pero con 2.000 lobbies, durante 600 s.
- **Predicción.** Antes de cada corrida, `campana.sh` escribió la predicción de `model.mjs` para el tráfico por diez en `resultados/_logs/`. La hora del archivo muestra que se escribió antes de medir.

**F8, larga duración.** Responde qué cambia con el tiempo. Una t3 acumula créditos de CPU mientras trabaja por debajo de su línea base y los gasta cuando la supera. En modo Unlimited, AWS cobra el exceso cuando se acaban los créditos. En modo Standard, frena la instancia a la línea base. La Unlimited recibió 10 req/s durante 40 minutos y la Standard 23 req/s durante 90 minutos. Las dos corridas también muestran si la memoria de la app crece sin parar durante una corrida larga, que sería señal de una fuga.

**F7d, datos por diez y por cien con la predicción escrita antes.** Responde lo mismo que la parte de datos de F7, pero corrige un defecto. En F7 la predicción de datos por diez se hizo después de medir. F7d la escribe antes. `prediccion_datos.mjs` toma el ajuste de F2 para la app y para `mongod` por separado, le suma el costo de ver un lobby que midió F1 y predice la utilización a 10 req/s con 2.000 y con 20.000 lobbies. Después corre 600 s con cada tamaño y el código corregido.

**F9, datos que no caben en la caché.** Responde cuándo empieza a importar el disco. En todas las fases anteriores la base cabe en la caché de WiredTiger, el motor de almacenamiento de MongoDB, así que el disco no trabaja.

- **Siembra.** F9 inserta los lobbies directamente en `mongod`, porque crearlos por la API tomaría horas. Cada uno lleva unos 3 KB de texto aleatorio que la compresión casi no reduce. Están cancelados para que el listado no los devuelva.
- **Bases comparadas.** Una base de 20.000 lobbies, unos 60 MB, cabe en la caché. La otra no cabe. En el contenedor tiene 400.000 lobbies, unos 1,2 GB, con `mongod` limitado a 512 MB, de los que WiredTiger toma 256 MB, pero esa corrida aún no la hacemos. En la t3.small tiene 1.000.000 de lobbies, unos 3 GB, frente a 1,9 GiB de RAM.
- **Carga.** Solo pide lobbies al azar por su id, de 25 a 400 req/s, con 300 s por nivel, y se detiene en el primer nivel que falla. Cuando los datos no caben, muchas peticiones tienen que leer del disco, y deberían aparecer IOPS y `wa` distintos de cero.

**Cuándo pasa un nivel.** Un nivel pasa si el p95 es de 1.000 ms o menos y los errores no superan el 1 %. Los dos valores están en `telemetry/profiles/umbrales.json`. El límite de 1.000 ms lo declaramos nosotros. Con el código corregido ningún nivel cambia de resultado si el límite es 300 o 500 ms. Para recomendar una opción a una tasa pedimos además que su recurso más ocupado quede en promedio al 60 % de su capacidad o menos, y dejamos el resto como margen.

**Qué mide el agente.** `agent.mjs` toma una muestra por segundo, o cada 2 s en Windows. Registra la CPU de la máquina repartida en `us`, `sy`, `wa` y `steal`, la CPU de cada proceso, el RSS, las IOPS y los MB/s de disco y los bytes de red. En Docker registra también el frenado de la cuota. De `mongod` registra las consultas, los documentos examinados y los fallos de caché de WiredTiger. `report.mjs` cruza esas muestras con la ventana de medición de cada nivel y deja fuera el calentamiento.

## 2. Entornos

### PC, la máquina física

Es un portátil con un AMD Ryzen 7 7445HS, de microarquitectura Zen 4, lanzado en 2023 y con un TDP de 35 W. Tiene 6 núcleos y 12 hilos. La ficha de AMD da 3,2 GHz de base y hasta 4,7 GHz de turbo. Nuestro microbenchmark, en `resultados/_microbench_ryzen_20261108/`, midió 4,7 GHz sostenidos en el núcleo 0. Un hilo fijado en los núcleos 1 a 3 se queda en 3,15 GHz bajo Windows. Cada núcleo tiene 64 KB de L1 y 1 MB de L2, que suman 6 MB, y los seis comparten 16 MB de L3. La latencia de acceso medida es 0,85 ns en L1, 2,96 ns en L2, de 10,7 a 14,8 ns en L3 y de 85,7 a 112,9 ns en RAM.

Tiene 15,2 GB de RAM visibles, en un solo módulo DDR5 de 16 GiB a 5.600 MT/s, es decir un solo canal de memoria. Lo leímos con `Get-CimInstance Win32_PhysicalMemory`, que da `SMBIOSMemoryType` 34, el código de DDR5. Tiene un SSD NVMe de 512 GB. El disco da 41.903 IOPS en lectura aleatoria de 4 KiB, con 375 µs en p50, 1.488 IOPS de escritura con `fsync` y 1.306,8 MB/s en lectura secuencial. Corre Windows 11 Home, Oracle Java 25 y MongoDB 9.0.4, con una caché de WiredTiger de 7.287 MB.

LobbyLink no usa todo el equipo. `run.mjs` fija la app y `mongod` en los hilos 0 a 7, que son 4 núcleos físicos con SMT, y el generador en los hilos 8 a 11. El generador corre en la misma máquina, así que el tráfico va por loopback y no por una red.

### Contenedor `a1m1`, con límites nuestros

Corre en el mismo Ryzen, dentro de Docker Desktop 29.8.2, sobre la VM Linux de WSL2, que ve 12 CPU y 7,4 GB. Nosotros fijamos los límites en `envs/compose.yml`. La app recibe 1 CPU y 1 GB, y `mongod` corre en otro contenedor con otra CPU y otro GB. El planificador CFS del kernel aplica la cuota de CPU con `cpu.max = 100000 100000`, es decir 100 ms de CPU por cada periodo de 100 ms. Si el contenedor los gasta antes de que termine el periodo, el kernel lo detiene hasta el siguiente. A esa detención la llamamos frenado, que el agente registra como `throttled`. La cuota limita tiempo y no núcleos. El contenedor puede correr en cualquiera de las 12 CPU, pero en total no pasa de 1. Dentro del contenedor el microbenchmark da 4,63 GHz en cualquier vCPU, más que los 3,15 GHz que da Windows nativo fuera del núcleo 0.

El disco es un archivo virtual de la VM, guardado en el mismo NVMe. Da 79.766 IOPS en lectura aleatoria, 1.155 IOPS con `fsync` y 1.410,6 MB/s secuenciales. La cifra de lectura aleatoria es una cota superior, porque Windows puede servir parte de esas lecturas desde su caché en RAM. El software es Eclipse Temurin 21.0.12 y MongoDB 7.0.45. `mongod` solo ve 1 GB, así que su caché de WiredTiger queda en el mínimo de 256 MB. La JVM también calcula su heap con ese GB. Toma un cuarto, unos 256 MB, y con 1 CPU visible elige Serial GC.

### EC2 t3.small, la opción de nube

Es una instancia de AWS en us-east-1c con un Intel Xeon Platinum 8259CL, de microarquitectura Cascade Lake, lanzado en 2019. Su nombre de modelo dice 2,5 GHz y la ficha de T3 da un turbo sostenido de hasta 3,1 GHz. Medimos 3,07 GHz con un hilo y 2,82 GHz por hilo con los dos ocupados. Tiene 2 vCPU, que son los dos hilos de un solo núcleo físico y comparten 64 KB de L1 y 1 MB de L2. El chip entero tiene 35,75 MB de L3, que la instancia comparte con otros clientes del servidor. La latencia medida es 1,62 ns en L1, 4,54 ns en L2, de 24,7 a 29,9 ns en L3 hasta unos 4 MB y de 100,9 a 118,1 ns en RAM desde 8 MB. El L3 que le toca a la instancia es entonces mucho menor que el de la ficha.

Tiene 1,9 GiB de RAM y un volumen EBS gp3 de 20 GiB, que va por la red del centro de datos. AWS le pone límites al volumen y el disco se detiene en ellos. Da 3.049 IOPS en lectura aleatoria, con 10 ms por lectura en p50, 27 veces más que el NVMe. Da 354 IOPS con `fsync` y 127,3 MB/s. La red hacia el generador da 4.953 Mbit/s. El generador corre en otra instancia de la misma red privada, una c7i-flex.large de 2 vCPU y 4 GiB. El software es Ubuntu 26.04.1 con kernel 7.0.0-1016-aws, Java 21.0.12 y MongoDB 7.0.45, con una caché de WiredTiger de 440 MB.

La t3.small es una instancia de rendimiento variable. Su línea base es el 20 % de cada vCPU y gana 24 créditos de CPU por hora. En modo Unlimited puede pasar de esa línea base, y AWS cobra los créditos de más a 0,05 USD por vCPU-hora. En modo Standard, cuando se acaban los créditos, el hipervisor la deja en 0,4 vCPU y Linux muestra el resto como `steal`. Medimos los dos modos. La instancia cuesta 0,0208 USD por hora bajo demanda.

## 3. Resultados

La tabla junta la carga sostenida de F6 con `mezcla-lectura` y los recursos del último nivel que pasan las tres opciones, en la repetición r1. Ese nivel es 10 req/s con el código original y 80 req/s con el corregido. Las latencias van en ms y la CPU de cada proceso en porcentaje de un núcleo.

|  | PC original | Contenedor original | t3.small original | PC corregido | Contenedor corregido | t3.small corregido |
| --- | --- | --- | --- | --- | --- | --- |
| Mayor λ que pasa en F6 | 20 req/s, 40 en 2 de 3 | 10 req/s | 10 req/s | 80 req/s, y 320 | 80 req/s | 80 req/s |
| p50 / p95 / p99 en el nivel de la tabla | 20,7 / 218 / 245 | 72,7 / 408 / 765 | 22,4 / 393 / 605 | 9,8 / 19,9 / 22,4 | 10,6 / 20,7 / 22,4 | 7,8 / 16,4 / 35,9 |
| CPU de la máquina, promedio / pico | 19,4 % / 76 % | 10,2 % / 17,5 % de la VM | 48,2 % / 99,5 % | 15,7 % / 58 % | 6,6 % / 8,8 % de la VM | 28,8 % / 97,1 % |
| `us` / `wa` / `steal` | 8,9 % / no aplica | 5,0 % / 0,0 % / 0 % | 39,9 % / 0,0 % / 0,5 % | 6,0 % / no aplica | 2,9 % / 0,0 % / 0 % | 23,8 % / 0,0 % / 1,2 % |
| CPU app / `mongod`, promedio | 27 / 77 | 41 / 56 | 34 / 62 | 19 / 22 | 26 / 21 | 33 / 23 |
| RSS app / `mongod` en MB | 241 / 96 | 217 / 80 | 260 / 189 | 246 / 132 | 219 / 82 | 250 / 162 |
| Disco, IOPS / MB/s | 29 / 1,98, todo el equipo | 0 / 0,01 | 1 / 0,01 | 19 / 2,75, todo el equipo | 0 / 0,01 | 1 / 0,01 |
| Red de salida en MB/s | loopback | 0,79 | 0,17 | loopback | 0,90 a 40 req/s | 1,39 |
| Documentos examinados por petición | 20.432 | 20.413 | 20.412 | 602 | 602 | 602 |
| Fallos de caché de WiredTiger | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % |
| Tráfico por diez, 100 req/s | 100 % de errores | 100 % de errores | 100 % de errores | p95 19,9 ms | p95 20,7 ms | p95 16,4 ms |
| Datos por diez, 2.000 lobbies | 99,18 % de errores | 99,18 % de errores | 99,18 % de errores | p95 45,4 ms | p95 45,4 ms | p95 62,2 ms |
| Costo mensual | 39,84-41,39 USD | 6,64-6,92 USD | 35,91 USD | 39,84-41,39 USD | 6,64-6,92 USD | 21,26 USD |

En el PC el agente mide el disco de todo el equipo, no el de LobbyLink. La app y `mongod` leen 0 MB/s. Cuando un nivel falla, falla entero. A 20 req/s la t3.small con el código original responde entre 1,8 y 2,2 req/s, con 89-95 % de errores. El p50 de `mezcla-lectura` salta entre unos 20 y 170 ms según la repetición. La mitad de las peticiones ven un lobby, que tarda unos 13 ms, y la otra mitad listan, que con el código original tarda unos 200 ms. La mediana cae justo entre los dos grupos, y por eso comparamos con p95 y p99.

Cada entorno responde las preguntas del enunciado y las de la sustentación. Las del enunciado son si aguanta la carga, dónde espera, qué le sobra, qué le falta y cuánto cuesta. Las de la sustentación son qué componente lo causa y qué se rompe primero si la carga se multiplica por diez.

### PC

**¿Aguanta la carga?** Con el código original aguanta 20 req/s en las tres repeticiones. A 40 req/s pasa dos veces, con p95 de 629 y 827 ms, y falla la tercera, así que 40 no es fiable. Con el código corregido pasa toda la escala y también 160 y 320 req/s, con p95 de 17,7 a 19,2 ms.

**¿Dónde espera?** En la CPU, y la mayor parte la gasta `mongod`. A 10 req/s con el código original, `mongod` usa 77 % de un núcleo y la app 27 %. En F3 el listado se reparte entre hilos casi sin pérdida, con una fracción paralela p = 0,981. El máximo es 28,8 req/s con 8 clientes, con `mongod` a 572 % y la app a 153 %, y en ese punto los 8 hilos que le dimos están llenos. La app y `mongod` leen 0 MB/s de disco, porque los datos caben en la caché de 7.287 MB.

**¿Qué componente lo causa?** El número de núcleos. El PC le da a LobbyLink 4 núcleos físicos y la t3.small 1, y por eso el techo del PC con el código original es 3 veces el de la t3.small, 71 contra 23,3 req/s. No llega a 4 veces porque cada petición cuesta más en Windows nativo. El login, que es cálculo puro con BCrypt, cuesta 112,1 ms en Windows y 56,0 ms en el contenedor sobre el mismo chip. La frecuencia explica una parte. Windows deja un hilo fijado fuera del núcleo 0 en 3,15 GHz en lugar de 4,7, un cociente de 1,49, y el del login es 2,0. El resto no lo pudimos explicar.

**¿Qué le sobra y qué le falta?** Le sobran CPU, RAM y disco. Con el código corregido a 80 req/s ocupa el 5 % de sus 8 hilos. Le faltan las condiciones de un servidor. Es un portátil con Windows, no tiene IP pública y no tiene respaldo de energía ni de disco.

**¿Cuánto cuesta?** Cuesta 129.000-134.000 COP al mes, que son 39,84-41,39 USD con la TRM del 2026-11-08. El cálculo usa supuestos nuestros. Deprecia 4.000.000 COP en 36 meses y suma la energía de 35 W de TDP a 700-900 COP/kWh. No incluye el plan de internet. La instancia de nube más parecida, una c7a.2xlarge con 8 núcleos Zen 4, cuesta 301,31 USD al mes, y no la medimos.

**¿Qué se rompe si la carga se multiplica por diez?** Con el código original se rompe la CPU. A 100 req/s `mongod` llega a 568 % y la app a 192 %, que es el 95 % de los 8 hilos, y el 100 % de las peticiones vence el tiempo límite. Con 2.000 lobbies a 10 req/s responde 0,08 req/s. Con el código corregido no se rompe nada, y a 100 req/s ocupa el 6,5 % de los hilos.

### Contenedor

**¿Aguanta la carga?** Con el código original aguanta 10 req/s, con p95 de 408 a 478 ms, y falla en 20. Con el código corregido pasa toda la escala, y en la rampa F5 llega a 314,3 req/s.

**¿Dónde espera?** En la cuota de CPU. Con el código original limita la cuota de `mongod`. Con 1 CPU para cada contenedor el máximo de F4 es 18,0 req/s. Darle 4 CPU a la app lo deja en 17,8, y darle 2 CPU a `mongod` lo sube a 26,9. Con el código corregido limita la cuota de la app, y el máximo con 1 CPU para `mongod` sube a 410 req/s. Cuando la cuota limita, el frenado llega a 3.951-5.160 ms por segundo, así que el kernel tiene detenido al contenedor la mayor parte de cada periodo. El disco y la red no hacen esperar a la app. El disco hace 0 IOPS en promedio y la caché no tiene fallos.

**¿Qué componente lo causa?** Dos límites que pusimos nosotros. Uno es la cuota CFS de 1 CPU. El otro, que no esperábamos, es el heap de la JVM, que con 1 GB visible toma unos 256 MB y usa Serial GC. Con el tráfico por diez el heap se llenó, 243 de 247 MB, y la app pasó el 19,5 % del tiempo en recolecciones completas. El Ryzen es más rápido por hilo, pero un listado con el código original cuesta casi lo mismo que en la t3.small, 169,8 contra 167,4 ms. Cada una de las \~406 consultas cruza la red virtual de Docker, y el kernel gasta tanto como el código, con `sy` en 5,2 % y `us` en 5,0 %. Repetimos el tráfico por diez con el heap fijado en 700 MB (`-Xmx700m`, `20261110_051149_docker_v3xmx-a1m1-f7-trafico-x10`). A 10 req/s el p95 es 459,4 ms, contra 424,7 ms con el heap por defecto, y a 100 req/s siguen fallando el 100 % de las peticiones (p95 10.181 ms, el tope del timeout). El heap llegó a 732 MB residentes y ya no hubo `OutOfMemoryError`, pero la cuota de CPU quedó saturada: la app usó 70 % de media y 99 % de máximo de su núcleo, y `mongod` 101 % de media. El heap era un riesgo real, pero no la causa de que falle a 100 req/s: la causa es la CPU de `mongod` con el código original.

**¿Qué le sobra y qué le falta?** Le sobran disco y memoria del contenedor, porque la app usa 219 MB de RSS de su GB. Le falta heap cuando se forma cola. Corre sobre el PC, así que también le faltan las condiciones de un servidor.

**¿Cuánto cuesta?** La sexta parte del PC, porque sus cuotas son 2 de los 12 hilos. Son 21.500-22.400 COP al mes, o 6,64-6,92 USD. En AWS lo más parecido es una c7a.large de 2 núcleos Zen 4 y 4 GiB, que cuesta 76,53 USD al mes y no medimos.

**¿Qué se rompe si la carga se multiplica por diez?** Con el código original cede primero la memoria de la JVM y después la CPU. La app llega al 97 % de su cuota con `mongod` al 53 %, el heap se llena y el 100 % de las peticiones falla. Con 2.000 lobbies las recolecciones completas ocupan el 77,3 % del tiempo. Con el código corregido la app usa el 33 % de su cuota a 100 req/s y el p95 es 20,7 ms.

### EC2 t3.small

**¿Aguanta la carga?** En Unlimited, con el código original, aguanta 10 req/s con p95 de 393 a 408 ms. En 20 req/s falla, y el 88,9 % de las peticiones vence el tiempo límite. Con el código corregido pasa toda la escala, con p95 de 12 a 16 ms y 0 errores en las tres repeticiones, y en la rampa llega a 267,6 req/s. En Standard sin créditos, el código original solo pasa 2 req/s.

**¿Dónde espera?** En la CPU. A 10 req/s con el código original, `us` es 39,9 % con `wa` 0,0 %, y `mongod` usa 62 % de un núcleo contra 34 % de la app. Con un cliente, el p50 del listado es 153,2 ms y su CPU 167,4 ms, casi lo mismo, así que la petición pasa su tiempo ejecutando consultas. El disco hace 1 IOPS en promedio, el 0,28 % de las 354 escrituras con `fsync` que soporta, y esas escrituras son las del journal de WiredTiger. La salida de red es 1,39 MB/s a 80 req/s, el 0,22 % de lo que midió `iperf3`. En Standard sin créditos la espera aparece como `steal`, con 78,8 % de `steal` y 16,8 % de `us` a 10 req/s.

**¿Qué componente lo causa?** El único núcleo físico. En F3 la t3.small deja de rendir más con 2 clientes, porque sus dos vCPU comparten el núcleo, mientras el PC sigue subiendo hasta 8 clientes. Ese núcleo además es más lento por hilo. Con el mismo Java y el mismo MongoDB, el login cuesta 83,1 ms en el Xeon y 56,0 ms en el Ryzen, 1,48 veces más. La frecuencia medida da un cociente de 4,63 / 3,07 = 1,51 y explica casi toda esa diferencia. La memoria no es la causa. Si cada uno de los \~40.800 documentos que examina un listado fuera un fallo a RAM de 118 ns, sumarían 4,8 ms de los 167,4 ms de CPU, un 2,9 %. La línea base del 20 % limita además al núcleo. El hipervisor la impone en Standard, y en Unlimited AWS cobra lo que pase de ella.

**¿Qué le sobra y qué le falta?** Le sobran disco y red. También le sobra memoria mientras el nivel pasa, porque usa 449 de 1.905 MB y pasa el 0,42 % del tiempo en pausas del GC. En los 40 minutos de F8 el RSS de la app sube de 310 a 324 MB, sin señal de fuga. Le falta CPU, porque tiene un solo núcleo y AWS lo raciona con créditos.

El disco sigue sobrando aunque los datos no quepan en memoria. En F9 sembramos 1.000.000 de lobbies, 3.117 MB contra 1,9 GiB de RAM y 440 MB de caché de WiredTiger, y pedimos lobbies al azar. Los fallos de caché subieron de 0 % a 12-14 %, y a 400 req/s el disco hizo 365 IOPS y 12,9 MB/s, con `wa` 3,4 % y 21 % de utilización del volumen. Son 0,9 lecturas por petición y el 12 % de las 3.049 IOPS de F0. El p95 subió de 28 a 121 ms y el p99 de 581 a 1.089 ms, pero todos los niveles pasaron. Con la base en caché, el mismo nivel hizo 1 IOPS. La CPU de la máquina llegó al 72 % en los dos casos, así que el núcleo sigue siendo lo primero que se llena.

**¿Cuánto cuesta?** La instancia cuesta 15,18 USD al mes, 730 h × 0,0208 USD, y el EBS 1,60 USD, así que la base es 16,78 USD. A eso se suman los créditos que medimos en CloudWatch. Con el código original a 10 req/s los créditos suman 19,13 USD y el total es 35,91 USD, así que los créditos cuestan más que la instancia. Con el código corregido no paga créditos a 40 req/s, porque la CPU queda en 14,9 %, bajo la línea base. A 80 req/s paga 4,48 USD de créditos y el total es 21,26 USD. Si los clientes están en internet y la carga dura todo el mes, AWS cobra la transferencia de salida a 0,09 USD/GB después de 100 GB gratis. El total sube a 47,81 USD a 10 req/s, 167,80 a 40 y 334,74 a 80.

**¿Qué se rompe si la carga se multiplica por diez?** Con el código original se rompe la CPU. A 100 req/s llega a 99,9 % y el 100 % de las peticiones falla, como predijo el modelo con 429 % de las 2 vCPU. Con el código corregido la CPU queda en 34 % a 100 req/s, contra 30 % predicho, y con 2.000 lobbies el p95 es 62,2 ms.

Con cien veces los datos, 20.000 lobbies a 10 req/s, se rompe la memoria y no la CPU. `prediccion_datos.mjs` escribió antes de la corrida una utilización de CPU de 37 %, pero falló el 100 % de las peticiones. La JVM tomó por defecto un heap de 478 MB, la cuarta parte de la RAM. Con 2.000 lobbies cada listado ya pesa unos 340 KB de JSON, que salen de 1,68 MB/s de red divididos entre unos 5 listados por segundo, así que con 20.000 serían unos 3,4 MB por respuesta antes de contar los objetos que la JVM arma para producirla. El registro de la app muestra 95 pausas Full GC y 4 `OutOfMemoryError`. Uno de ellos mató el hilo `http-nio-8080-Poller` de Tomcat, que acepta las conexiones, y por eso fallaron también las consultas de un lobby. Repetimos con `-Xmx1g`. A los 30 s de carga el kernel mató a Java por falta de memoria, con 949 MB residentes, mientras `mongod` ocupaba unos 580 MB. En una máquina de 1,9 GiB un heap más grande no alcanza.

Repetimos F7d con la predicción escrita antes en el PC y en el contenedor (`resultados/_logs/prediccion_datos_windows_20261110_003850.md` y `prediccion_datos_docker_20261110_011032.md`). Con 2.000 lobbies pasan los dos: el PC con p95 45,4 ms y el contenedor con 42,0 ms, ambos con 0 errores. Con 20.000 lobbies el resultado se parte según la memoria. El PC pasa con 0 errores y p95 335,7 ms (`20261110_055215_windows_v3fix-f7d-datos-20000`): la app llegó a 1.938 MB residentes porque la JVM ve 16 GB y toma un heap grande. El contenedor falla el 100 % de las peticiones, como la t3.small (`20261110_062413_docker_v3fix-a1m1-f7d-datos-20000`), aunque la predicción decía 27 % de CPU de la app. Su heap por defecto es de 247 MB, y `app.log` registra 1.782 pausas Full GC por falta de espacio y 178 líneas de `OutOfMemoryError`; la CPU de la app promedió 48 % de su cuota. Falla la memoria, no la CPU, en las dos máquinas que le dan a la JVM un heap de cuarto de RAM.

## 4. Respuestas para la aplicación

**¿Dónde espera LobbyLink, en la CPU, en el disco o en la red?** En la CPU, en las tres opciones y con los dos jars. La prueba más limpia es la t3.small con el código original a 10 req/s, con `us` 39,9 %, `wa` 0,0 %, 1 IOPS de disco y 0,03 % de la red disponible. `mongod` gasta la mayor parte de esa CPU, entre el 58 y el 75 % del costo del listado, porque cada listado hace unas 206 `find` y 200 conteos. El disco no participa porque los datos ocupan unos 10 MB y caben enteros en la caché de WiredTiger, con 0 % de fallos en las tres opciones. Cuando no caben, como en F9 con 3.117 MB en la t3.small, el disco aparece, pero a 400 req/s usa el 12 % de sus IOPS y la CPU sigue llenándose primero.

**¿Por qué ese número y no otro?** La capacidad sale de la ley de utilización, U = λ · D. En F1 medimos D con un cliente, restando la CPU de reposo a la CPU usada y dividiendo entre las peticiones. El modelo predice el techo como la capacidad dividida entre D. En la rampa, la utilización medida quedó a entre 1 y 8 puntos de la predicha. Fuera del rango medido el modelo acierta menos. Con 2.000 lobbies en la t3.small predijo 9 % y midió 14 %. Con 20.000 predijo 37 % de CPU y la app se quedó sin memoria, un recurso que el modelo no incluye. Lo que falla antes del techo es la latencia. Con el código original un listado ocupa la CPU entre 150 y 210 ms, y basta una cola de unas 5 peticiones para pasar de 1 s, así que el codo cae al 50-62 % del techo. Con 7 ms por listado hacen falta unas 140 peticiones en cola, y el codo sube al 80-90 %.

**¿Qué componente causa cada número?** Los núcleos del procesador explican el techo, porque el PC le da 4 a LobbyLink y la t3.small 1. La frecuencia por hilo explica el costo de BCrypt, que es 1,48 veces mayor en el Xeon, cuya frecuencia medida es 1,51 veces menor. En el PC nativo, el contador de frecuencia por hilo durante F1 de login (`20261110_045149_windows_v3frec-f1-login`) da 2.126 MHz ponderados por ocupación en los hilos de la app, contra 2.768 MHz en el listado (`20261110_050048_windows_v3frec-f1-list`), donde los hilos 0 y 1 llegan a 3,5-3,7 GHz. En el contenedor medimos 4,63 GHz. La razón 4.630 / 2.126 = 2,18 se parece a la razón de latencias del login, 111,9 ms contra 59,8 ms (1,87): el login en Windows nativo corre con el reloj bajo. El contador es de Windows y no probamos qué lo limita (energía o planificación), así que no atribuimos la causa más allá del reloj. El SMT explica que la t3.small llegue a su máximo con 2 clientes. El segundo hilo de un núcleo aporta +84 % en login en el PC y +71 % en la t3.small. La cuota CFS explica el frenado del contenedor, y el límite de memoria que ve la JVM explica su heap de 256 MB. La línea base del hipervisor explica el 78,8 % de `steal` en Standard. La RAM y la caché de WiredTiger explican que el disco no importe.

**Si la carga se multiplicara por diez, ¿qué se rompería primero?** Con el código original se rompe la CPU, por el listado con N+1, en las tres opciones y en los dos escenarios. `campana.sh` dejó escrita la predicción antes de medir. Daba 141 % de los hilos del PC, 499 % de la cuota de `mongod` en el contenedor y 429 % de las vCPU de la t3.small. Con diez veces más datos el resultado es el mismo, 99,18 % de errores. El listado examina N² documentos, y con 2.000 lobbies esa parte cuadrática ya es el 42-67 % de la CPU de `mongod`. En el contenedor el heap de la JVM cede antes que la CPU. Con el código corregido no se rompe nada en ninguna opción. Con cien veces los datos, en cambio, la t3.small con el código corregido se queda sin memoria, porque el listado sin paginar arma en la JVM una respuesta con los 20.000 lobbies.

**¿Qué opción descartamos y por qué?**

- **t3.small Standard.** Sin créditos atiende 2 req/s con el código original. Con el corregido, el gasto de créditos iguala a la ganancia entre 58 y 67 req/s, y por encima de eso la instancia caería a la línea base. Unlimited cuesta lo mismo hasta 40 req/s y no tiene ese riesgo.
- **PC.** Es la opción con más capacidad medida, pero no es un servidor, y su costo depende de supuestos nuestros. No lo descartamos por precio. Con transferencia, la t3.small cuesta más que el PC desde unos 8 req/s sostenidos.
- **Contenedor.** Pasa la misma carga que la t3.small, pero corre sobre el PC y tiene las mismas carencias. Para usarlo en un servidor habría que fijar el heap con `-Xmx` en proporción a su límite de memoria.
- **c7a.2xlarge.** Es lo más parecido al PC en AWS, pero cuesta 301,31 USD al mes, 18 veces la t3.small, y LobbyLink con el código corregido no necesita esa capacidad.

**Recomendación.** Recomendamos desplegar LobbyLink con el arreglo del N+1 en una EC2 t3.small en modo Unlimited con 20 GiB de EBS gp3. La infraestructura cuesta 16,78 USD al mes hasta 40 req/s y 21,26 USD a 80 req/s. A 80 req/s la CPU queda en 28,8 %, bajo la regla del 60 %, con p95 de 16 ms y 0 errores en 3 repeticiones. Con el tráfico por diez usa el 34 % de la CPU. La recomendación vale mientras la base tenga pocos miles de lobbies abiertos. Con 2.000 pasa y con 20.000 falla por memoria, así que antes de llegar a ese tamaño hay que paginar `GET /api/lobbies`. Si hubiera que desplegar el código original, la recomendación sería la misma instancia solo hasta 10 req/s, por 35,91 USD al mes, y ninguna opción resistiría la carga por diez.

## 5. Cambios y mejoras visibles

El arreglo, en `LobbyLink_backend_nplus1/`, cambia solo `LobbyServiceImpl`. Cuenta los participantes de todos los lobbies con una sola agregación, en lugar de un conteo por lobby. Busca todos los videojuegos a la vez con `findAllById`, en lugar de uno por lobby. No agrega índices, no cambia el modelo de datos y la API responde lo mismo.

Las mediciones muestran estas mejoras:

- El listado bajó de 220,3 a 7,2 ms de CPU en el PC, de 169,8 a 6,9 en el contenedor y de 167,4 a 7,1 en la t3.small, entre 24 y 31 veces menos. Los documentos examinados por petición bajaron de 20.412 a 602. En la t3.small a 10 req/s, las operaciones de `mongod` bajaron de 1.998 a 54 por segundo.
- El techo predicho subió de 71 a 1.288,9 req/s en el PC, de 20 a 262,3 en el contenedor y de 23,3 a 336,5 en la t3.small.
- En la carga sostenida, el mayor nivel que pasan las tres opciones subió de 10 a 80 req/s, el máximo de la escala. El p95 bajó de 393-478 ms a 12-23 ms.
- El exponente del costo del listado contra el número de lobbies bajó de 1,10-1,21 a 0,50-0,64. Con 1.600 lobbies, un listado pasó de 2,1-2,4 s a 22-29 ms de CPU.
- Con la carga multiplicada por diez, las tres opciones pasaron de fallar a pasar con 0 errores, en el escenario de tráfico y en el de datos.
- En la t3.small a 10 req/s, los créditos bajaron de 19,13 USD al mes a 0, y la infraestructura de 35,91 a 16,78 USD.
- Cambió el proceso que limita. Con el código original limita `mongod`. Con el corregido la app gasta algo más que `mongod`, 3,6 contra 2,3 ms por petición en la t3.small, y en el contenedor la cuota de la app es la primera que se llena.

Cambiar de máquina rinde menos que corregir el código. Pasar de la t3.small al PC multiplica por 3 el techo del código original. Corregir el código en la misma t3.small lo multiplica por 14.

## 6. Dónde falla ahora y qué falta decir

Con el código corregido, ningún nivel de F6 ni de F7 falla en ninguna opción. La aplicación sigue teniendo un límite, y nuestras mediciones dejan preguntas sin responder.

**Dónde se rompe ahora.** El límite sigue siendo la CPU, pero a tasas entre 27 y 52 veces mayores que con el código original. En la rampa F5, el último nivel que pasa es 267,6 req/s en la t3.small, el 80 % de su techo predicho de 336,5. En el contenedor es 314,3 req/s y en el PC 1.034 req/s. La t3.small Standard llega antes a su límite, entre 58 y 67 req/s, cuando se le acaban los créditos. En el contenedor, si se forma cola, el heap de 256 MB vuelve a ser un riesgo mientras nadie fije `-Xmx`. Con 20.000 lobbies la t3.small falla a 10 req/s por memoria, como cuenta la sección 3.

**Lo que el arreglo no resolvió.** El listado sigue sin paginación. Con 2.000 lobbies el p95 es el doble que con 200, de 45 a 62 ms contra 20 a 22 ms, porque cada respuesta lleva diez veces más lobbies. Con 20.000 la respuesta ya no cabe en la memoria de la t3.small. Paginar el listado es el siguiente arreglo, y no lo medimos. El costo sigue creciendo con el tamaño de la base, con un exponente de 0,50-0,64. `participaciones.lobbyId` sigue sin índice. El login no cambió. BCrypt cuesta 83,6 ms de CPU por petición en la t3.small, así que sus 2 vCPU alcanzan como máximo para unos 24 logins por segundo. `mezcla-lectura` no tiene logins y por eso ese límite no aparece en F6. `mezcla-postman` sí los tiene, y su codo queda al 51-71 % del techo.

**Lo que falta medir o decir.**

- `mezcla-lectura` no tiene escrituras ni BCrypt. Los porcentajes de las dos mezclas salen de la colección Postman, no del uso real, y cada lobby sembrado tiene un solo participante.
- El caso de datos que no caben en memoria, F9, solo lo medimos en la t3.small y con una carga que pide un lobby a la vez. Allí el disco no llegó a limitar. Un recorrido completo de una base que no cabe, como el listado sin filtro sobre millones de lobbies, sí dependería de los 10 ms por lectura del EBS.
- En el PC y el contenedor el generador corre en el mismo equipo, aunque fijado en otros hilos. Docker corre sobre la VM de WSL2 y no sobre un Linux nativo. Medimos un solo tipo de instancia de nube. De la c7a.2xlarge y la c7a.large solo tenemos el precio de ficha.
- Las explicaciones de SMT, de la frecuencia y de la memoria salen de microbenchmarks de un hilo, no de contadores de hardware. No sabemos por qué Windows sostiene el turbo solo en el núcleo 0, ni qué causa el resto de la diferencia del login entre Windows y Linux.
- En el PC, los endpoints baratos de F1 tienen de 10 a 13 muestras, menos de las 30 que pide el modelo. F6 con el código corregido tiene 2 repeticiones en el PC y en el contenedor. Las pendientes de créditos salen de 2 a 5 puntos de CloudWatch por nivel. La predicción de datos por diez de F7 la extrapolamos después de medir. F7d la repitió con la predicción escrita antes en la t3.small, el PC y el contenedor, con una sola repetición por tamaño.
- El costo del PC usa un precio, una vida útil y una tarifa de energía supuestos, y el TDP de ficha en lugar de un vatímetro. El costo de transferencia supone que toda la salida medida va a internet durante 730 h, sin compresión ni CDN.
- El arreglo es nuestro y el proyecto no tiene pruebas automáticas, porque `src/test` está vacío. Lo validamos con F1 a F8, con la colección Postman y con una prueba de equivalencia, `telemetry/comparar_respuestas.mjs`. Esa prueba arranca los dos jars sobre la misma base y compara 95 respuestas, entre listados completos, listados filtrados por videojuego y detalles de 45 lobbies con 0 a 5 cupos libres, 13 de ellos llenos. Las 95 respuestas fueron idénticas campo por campo en la t3.small el 2026-11-09, en `resultados/_equivalencia_20261109_ec2/`.

## Datos crudos y guiones

- **Datos crudos.** Están en `lobbylink_perfv3/resultados/`, una carpeta por corrida. Las tablas del modelo, la validación y los créditos están en `resultados/_logs/`. Los precios de AWS y lo que cobró la consola están en `resultados/_aws_*`. F9 y F7d de la t3.small están en `resultados/ec2_t3small-pend/`, y la repetición de 20.000 lobbies con `-Xmx1g` en `resultados/ec2_t3small-xmx/`.
- **Guiones.** Son `campanas/campana.sh`, `campanas/campana_jar.sh` y la carpeta `telemetry/`.
- **Visor.** `dashboard/index.html` muestra todas las corridas.
- **Índice y comandos.** El anexo A del anexo técnico une cada sección con sus carpetas, y el anexo B da los comandos para repetir cada fase.
