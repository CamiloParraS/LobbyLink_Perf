# AWS con v3: t3.small en Unlimited y en Standard

Dos parejas de instancias en paralelo, en la **misma zona y subnet**. Cada pareja tiene un servidor (lo que se mide) y un generador (herramienta, no entra al costo):

| Pareja | Servidor | Créditos | Generador | Fases |
|---|---|---|---|---|
| A | t3.small | **Unlimited** | c7i-flex.large | Todas: F0-F6, luego F7 y F8 |
| B | t3.small | **Standard** | c7i-flex.large | F0, F1, F5, F6 (`REPS=2`) y F8 (ráfaga) |

En paralelo terminan en ≈ 5 h en vez de ≈ 9. Cada generador mide solo a su servidor; no compartas un generador entre los dos servidores.

## Por qué Standard tiene un plan distinto

- Una t3.small gana **24 créditos por hora** (línea base de 20 % por vCPU × 2 vCPU). Un crédito = 1 vCPU al 100 % durante 1 minuto. El saldo se mira en CloudWatch y no se supone. Las cifras de esta sección son de la ficha de AWS, así que verifícalas en la página oficial el día que midas y anota la fecha.
- En **Standard**, sin créditos, el hipervisor entrega solo la línea base (0,4 vCPU entre las dos). En Linux, la CPU que no se entrega aparece como **`steal`** (el reporte la muestra). En **Unlimited** no se frena, pero se cobran los créditos excedentes.
- Con 0,4 vCPU, una rampa centrada en el techo de 2 vCPU fallaría casi entera. Por eso la pareja B corre con `MODEL_POOL=0.4`: el modelo predice el techo con la línea base y F5 comprueba esa predicción. Es la respuesta medida a "¿qué opción descartamos?" si Standard no aguanta.
- La escala de F6 en B empieza en 1 req/s (`ESCALA="1 2 5 10 20"`), porque con 0,4 vCPU podría no llegar a 5. Los niveles 5, 10 y 20 son comunes con las otras opciones, así que la comparación sigue siendo la misma escala.
- F2 (datos) y F3 (Amdahl) no cambian con los créditos (son propiedades del código), así que solo se corren en A. Amdahl sobre una CPU frenada mediría el freno, no la app.
- **F8 en B mide cuánto dura la ráfaga.** Se deja el servidor en reposo 60 min (acumula unos 24 créditos) y se le pide una λ que necesite la CPU entera. Predicción, antes de medir: gasta 2 créditos/min y gana 0,4, así que 24 créditos duran ≈ 15 min. Luego cae a la línea base. El minuto en que `steal` sube y el p95 se dispara es el dato.

## 0. Antes de lanzar

- SG con SSH (22) desde **My IP** y **All TCP desde el propio SG**.
- Ubuntu 24.04, servidor con 20 GiB gp3. **Credit specification** (Advanced details → Credit specification): A = Unlimited, B = Standard. Para cambiarla después: `aws ec2 modify-instance-credit-specification --instance-credit-specification "InstanceId=<id>,CpuCredits=standard"`.
- Captura con fecha de la ficha y del precio por hora (t3.small, c7i-flex.large, EBS gp3, crédito excedente de t3 en Linux).
- Alarma de presupuesto. Costo esperado: cuatro instancias × ≈ 6 h más los créditos excedentes de A, del orden de 1 a 2 USD (verificar con los precios del día). **Costo real de la campaña ya hecha:** `resultados/_aws_costos_20261107/costos_consola.md` (lo leído en la consola de AWS: $5,87 brutos el 6 de noviembre, cubiertos por créditos) y la estimación por horas × precio en `resultados/_aws_costos_20261106/resumen_costos.md`. Las instancias estuvieron encendidas bastante más de 6 h.

## 1. Subir el código (desde el PC, Git Bash)

```bash
cd /c/TETO/UCC/QUINTO/ArquitecturaComputacional/Final/ArqComp
(cd LobbyLink_backend && ./mvnw.cmd clean package -DskipTests)
tar czf /tmp/perfv3.tgz --force-local --exclude=resultados lobbylink_perfv3
K=~/.ssh/lobbylink-perf.pem
for H in <IP_PUB_SRV_A> <IP_PUB_GEN_A> <IP_PUB_SRV_B> <IP_PUB_GEN_B>; do scp -i $K /tmp/perfv3.tgz ubuntu@$H:~ && ssh -i $K ubuntu@$H 'tar xzf perfv3.tgz && mkdir -p lobbylink_perfv3/resultados/_logs'; done
for H in <IP_PUB_SRV_A> <IP_PUB_SRV_B>; do scp -i $K LobbyLink_backend/target/disenofinal-0.0.1-SNAPSHOT.jar ubuntu@$H:~/app.jar; done
for H in <IP_PUB_GEN_A> <IP_PUB_GEN_B>; do scp -i $K $K ubuntu@$H:~/.ssh/lobbylink-perf.pem; done
```

## 2. Preparar (una vez por instancia)

```bash
ssh -i $K ubuntu@<IP_PUB_SRV_X> 'bash lobbylink_perfv3/setup/ec2-preparar.sh servidor'     # guarda la ficha que imprime
ssh -i $K ubuntu@<IP_PUB_GEN_X> 'bash lobbylink_perfv3/setup/ec2-preparar.sh generador && chmod 400 ~/.ssh/lobbylink-perf.pem'
```

Cierra y reabre la sesión SSH del servidor (grupo `docker`). Desde el generador, comprueba que `ssh ubuntu@<IP_PRIVADA_SRV>` entra sin preguntar.

## 3. Humo (≈ 25 min por pareja; no va al informe)

```bash
# en cada generador, dentro de tmux
cd ~/lobbylink_perfv3 && QUICK=1 FASES="f1 f5" ./campanas/campana.sh ec2 <IP_PRIVADA_SRV> humo-a                      # pareja A
cd ~/lobbylink_perfv3 && QUICK=1 MODEL_POOL=0.4 FASES="f1 f5" ./campanas/campana.sh ec2 <IP_PRIVADA_SRV> humo-b       # pareja B
```

Debe dejar `~/res/humo-*/f1-*/{load.ndjson,agent.ndjson}` y `~/res/humo-*/_logs/modelo_ec2_f1.md` con una X_max. Si F5 dice "no hay X_max", falta un F1 o el agente no trajo datos: mira `~/srv_*.log` en el servidor. Borra `~/res/humo-*` o déjalo; no se mezcla con lo real.

## 4. Campaña real

```bash
# pareja A (Unlimited)
tmux new -s camp
cd ~/lobbylink_perfv3 && ./campanas/campana.sh ec2 <IP_PRIVADA_SRV_A> t3small-unl
# pareja B (Standard). Anota CPUCreditBalance antes de empezar
tmux new -s camp
cd ~/lobbylink_perfv3 && MODEL_POOL=0.4 REPS=2 ESCALA="1 2 5 10 20" FASES="f0 f1 f5 f6" ./campanas/campana.sh ec2 <IP_PRIVADA_SRV_B> t3small-std
```

Después, con F6 a la vista, elige `BASE_RPS` (criterio en `docs/PLAN.md`):

```bash
# A: ×10 y corrida larga
BASE_RPS=<x> FASES="f7 f8" ./campanas/campana.sh ec2 <IP_PRIVADA_SRV_A> t3small-unl
# B: 60 min de reposo para acumular créditos, y ráfaga a una λ que pida la CPU entera (≈ el X_max de A en F5)
sleep 3600; BASE_RPS=<x> LARGO_RPS=<X_max de A> FASES="f8" ./campanas/campana.sh ec2 <IP_PRIVADA_SRV_B> t3small-std
```

Durante las corridas, mira el generador con `top`: si pasa de ~70 % de un núcleo, el nivel queda en duda (el reporte también marca `genOk`).

## 5. CloudWatch (créditos)

El generador no tiene credenciales de AWS. Al terminar cada pareja, en la consola: EC2 → instancia del servidor → Monitoring, o CloudWatch → Metrics → EC2 → Per-Instance. Guarda capturas o exporta CSV de `CPUCreditBalance`, `CPUCreditUsage`, `CPUSurplusCreditBalance` y `CPUSurplusCreditsCharged` (llega con retraso) y `CPUUtilization`, con resolución de 5 min, en `resultados/ec2_<etiqueta>/`.

## 6. Traer los datos y cerrar

```bash
cd /c/TETO/UCC/QUINTO/ArquitecturaComputacional/Final/ArqComp/lobbylink_perfv3
./campanas/recoger_ec2.sh <IP_PUB_GEN_A> t3small-unl
./campanas/recoger_ec2.sh <IP_PUB_GEN_B> t3small-std
node telemetry/model.mjs resultados/ec2_t3small-unl/f1-*                 # los informes de _logs ya vienen hechos
node telemetry/model.mjs resultados/ec2_t3small-std/f1-* --pool 0.4
```

Luego **termina** las cuatro instancias (Terminate, no Stop) y anota las horas de cada una para el costo (ver dónde quedaron los costos de la campaña de v3 en `resultados/_aws_costos_20261107/`).
