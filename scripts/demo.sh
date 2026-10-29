#!/bin/bash
# Monta uma demo completa e descartavel: um repositorio de brinquedo com algumas
# branches, um config apontando para os caminhos DESTA maquina, e uma conta de
# acesso com codigo publicado.
#
# Nao toca no config real nem no estado do agent. Roda sem Xcode, sem certificado
# e sem projeto — os passos de build sao simulados por mock/step.sh.
#
#   scripts/demo.sh                              monta em ./.demo
#   BUILD_CENTER_DEMO_DIR=/tmp/x scripts/demo.sh monta onde voce quiser
set -euo pipefail

raiz="$(cd "$(dirname "$0")/.." && pwd)"
demo="${BUILD_CENTER_DEMO_DIR:-$raiz/.demo}"
codigo="demo-codigo-de-acesso"
autor=(-c user.email=demo@example.com -c user.name=Demo)

echo "==> limpando $demo"
rm -rf "$demo"
mkdir -p "$demo/agent"

echo "==> repositorio de brinquedo"
src="$demo/src-repo"
mkdir -p "$src"
git -C "$src" init -q -b develop
echo "projeto de demonstracao" > "$src/README.md"
git -C "$src" add -A
git -C "$src" "${autor[@]}" commit -qm "primeiro commit"
for b in feat/exemplo fix/exemplo release/1.0.0; do
  git -C "$src" checkout -q -b "$b" develop
  echo "$b" >> "$src/README.md"
  git -C "$src" "${autor[@]}" commit -qam "trabalho em $b"
done
git -C "$src" checkout -q develop
echo "    develop, feat/exemplo, fix/exemplo, release/1.0.0"

echo "==> config da demo"
node "$raiz/scripts/demo-config.mjs" "$raiz" "$demo" "$codigo"

cat <<FIM

Pronto. Suba o painel com:

  BUILD_CENTER_CONFIG=$demo/config.json node $raiz/src/server.js

Depois abra http://127.0.0.1:8788 e entre com:

  usuario: dev-remoto
  codigo:  $codigo

Esse codigo esta no repositorio de proposito — a demo nao serve para producao,
e os cookies dela nao exigem HTTPS.

Para ver uma falha de build, crie um arquivo FAIL_development em alguma branch
do repositorio de brinquedo: o passo simulado le isso e sai com erro.
FIM
