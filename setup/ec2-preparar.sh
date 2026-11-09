#!/usr/bin/env bash
# Prepara una instancia EC2 (Ubuntu 24.04) para medir LobbyLink.
#   bash ec2-preparar.sh servidor    -> Java 21 + Docker (MongoDB 7) + Node 22. Deja listo todo para arrancar app + agente.
#   bash ec2-preparar.sh generador   -> Node 22 (solo genera la carga).
# La carpeta lobbylink_perfv3 y el jar se copian desde el PC con scp (ver setup/EC2.md). Volver a ejecutarlo es seguro.
set -euo pipefail
ROL="${1:-}"
[[ "$ROL" == "servidor" || "$ROL" == "generador" ]] || { echo "Uso: bash ec2-preparar.sh servidor|generador" >&2; exit 1; }

echo "== 1/3 Paquetes =="
export DEBIAN_FRONTEND=noninteractive   # iperf3 pregunta por debconf si se instala como servicio
sudo apt-get update -y -qq
sudo -E apt-get install -y -qq tmux curl sysstat fio iperf3 >/dev/null
if [[ "$ROL" == "servidor" ]]; then
  sudo apt-get install -y -qq openjdk-21-jre-headless docker.io >/dev/null
  sudo usermod -aG docker "$USER"
fi
printf '* soft nofile 65535\n* hard nofile 65535\n' | sudo tee /etc/security/limits.d/90-carga.conf >/dev/null
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( MEM_MB < 1500 )) && ! swapon --show | grep -q swapfile; then
  echo "Solo ${MEM_MB} MB de RAM: agrego 2 GB de swap (anotalo en el informe)"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
fi

echo "== 2/3 Node 22 =="
export NVM_DIR="$HOME/.nvm"
[[ -s "$NVM_DIR/nvm.sh" ]] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null
. "$NVM_DIR/nvm.sh"; nvm install 22 >/dev/null; node --version

if [[ "$ROL" == "servidor" ]]; then
  echo "== 3/3 MongoDB 7 en Docker (red del host, localhost:27017) =="
  sudo docker rm -f mongo >/dev/null 2>&1 || true
  sudo docker run -d --name mongo --network host --restart unless-stopped mongo:7 >/dev/null
  for i in $(seq 1 30); do (echo > /dev/tcp/127.0.0.1/27017) 2>/dev/null && break; sleep 1; done
  echo "MongoDB escuchando en :27017"
  echo
  echo "Ficha de la instancia (copiala al informe):"
  T=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
  echo "  tipo:       $(curl -s -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/instance-type)"
  echo "  zona:       $(curl -s -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/placement/availability-zone)"
  echo "  IP privada: $(curl -s -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/local-ipv4)"
  lscpu | grep -E 'Model name|^CPU\(s\)|Thread|L2|L3'; free -m | head -2; lsblk -d -o NAME,SIZE,ROTA,MODEL
  echo
  echo "Siguiente: copia ~/lobbylink_perfv3 y ~/app.jar desde tu PC y arranca:"
  echo "  cd ~/lobbylink_perfv3 && tmux new -s srv 'node telemetry/run.mjs --env linux --server-only --jar ~/app.jar --label ec2-t3small   2>&1 | tee ~/srv.log'"
else
  echo "== 3/3 Listo =="
  echo "Siguiente: copia ~/lobbylink_perfv3 y lanza la carga (ver setup/EC2.md, paso 5)."
fi
echo "Cierra la sesion SSH y vuelve a entrar para que el grupo docker y los limites apliquen."
