#!/bin/bash
# Instala o iOS Build Center como servico do launchd nesta conta.
#
# O que ele faz:
#   ~/build-center   codigo do agent (persistente)
#   ~/build-agent    estado, logs, workspaces, secrets, export-options
#   ~/Library/LaunchAgents/com.buildcenter.agent.plist
#
# O que ele NAO faz: nao abre porta publica, nao instala tunel, nao mexe
# em arquivos pessoais fora dos dois diretorios acima, nao pede sudo.
set -euo pipefail

SRC="${1:?uso: install.sh <diretorio-do-codigo> <diretorio-do-projeto> [--no-service]}"
PROJECT="${2:?uso: install.sh <diretorio-do-codigo> <diretorio-do-projeto> [--no-service]}"
# --no-service instala os arquivos e escreve o plist, mas nao registra o
# servico no launchd. Registrar um LaunchAgent e uma decisao do dono da maquina.
NO_SERVICE="${3:-}"
DEST="$HOME/build-center"
AGENT="$HOME/build-agent"
NODE="$(command -v node)"
LABEL="com.buildcenter.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -n "$NODE" ] || { echo "node nao encontrado no PATH"; exit 1; }

echo "==> diretorios"
mkdir -p "$AGENT"/{workspaces,logs,secrets,export-options}
chmod 700 "$AGENT" "$AGENT/secrets"

echo "==> codigo em $DEST"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude 'config.json' --exclude 'node_modules' \
  "$SRC"/ "$DEST"/
chmod +x "$DEST"/scripts/*.sh

# prod entrou a pedido do dono: o destino e o TestFlight, nao a App Store. O custo
# e que o secret de producao passa a existir nesta maquina, onde um build roda codigo
# de branch que ninguem revisou. Por isso o ambiente prod exige o papel "owner" no
# config: o dev remoto nao dispara, so quem e dono da maquina.
echo "==> secrets por ambiente (dev/hml/stg/prod)"
for env in dev hml stg prod; do
  if [ -f "$PROJECT/secrets.$env.json" ]; then
    cp "$PROJECT/secrets.$env.json" "$AGENT/secrets/secrets.$env.json"
    chmod 600 "$AGENT/secrets/secrets.$env.json"
    echo "    secrets.$env.json"
  else
    echo "    AUSENTE: secrets.$env.json"
  fi
done

# O Team ID identifica a conta de desenvolvedor Apple e muda para cada pessoa.
# Chumbado, geraria um ExportOptions que assina pela conta errada — ou por
# nenhuma. Vem do ambiente, e o script para se nao estiver definido.
TEAM_ID="${APPLE_TEAM_ID:?defina APPLE_TEAM_ID (developer.apple.com > Membership)}"

echo "==> export-options por flavor"
for env in dev hml stg prod; do
  cat > "$AGENT/export-options/$env.plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>stripSwiftSymbols</key><true/>
  <key>destination</key><string>export</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST_EOF
done
echo "    dev.plist hml.plist stg.plist prod.plist"

echo "==> LaunchAgent"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DEST/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BUILD_CENTER_CONFIG</key><string>$DEST/config.json</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$AGENT/agent.out.log</string>
  <key>StandardErrorPath</key><string>$AGENT/agent.err.log</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST_EOF

if [ "$NO_SERVICE" = "--no-service" ]; then
  echo "    plist escrito em $PLIST, nao registrado (--no-service)"
  echo "    para registrar:  launchctl bootstrap gui/\$(id -u) $PLIST"
else
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl enable "gui/$(id -u)/$LABEL"
fi

echo "==> pronto"
echo "    codigo:  $DEST"
echo "    estado:  $AGENT"
echo "    servico: $LABEL"
