#!/bin/bash
# Guarda um PAT do Azure DevOps num credential store do git.
#
#   set-repo-credential.sh agent   -> ~/build-agent/git-credentials  (so o agent le)
#   set-repo-credential.sh user    -> ~/.git-credentials             (seu uso normal)
#
# O PAT e lido da entrada padrao sem eco, nao aparece em argv, nao vai para o
# histórico do shell e nao e impresso em lugar nenhum.
set -euo pipefail

target="${1:-}"
case "$target" in
  agent) file="$HOME/build-agent/git-credentials" ;;
  user)  file="$HOME/.git-credentials" ;;
  *) echo "uso: set-repo-credential.sh agent|user" >&2; exit 1 ;;
esac

host="${AZURE_HOST:-dev.azure.com}"
# Organizacao, projeto e repositorio vem do ambiente. Chumbar os meus aqui
# funcionaria nesta maquina e seria uma pegadinha em qualquer outra.
org="${AZURE_ORG:?defina AZURE_ORG com a organizacao do Azure DevOps}"
project="${AZURE_PROJECT:?defina AZURE_PROJECT}"
repo="${AZURE_REPO:?defina AZURE_REPO}"
user="${AZURE_USER:-$org}"

echo "Destino : $file"
echo "Host    : https://$host  (usuario $user)"
echo
echo "Crie o PAT em: https://$host/$org/_usersSettings/tokens"
if [ "$target" = agent ]; then
  echo "Para o agent, marque APENAS: Code → Read"
fi
echo

printf 'Cole o PAT (nao aparece na tela): '
IFS= read -rs pat
echo
[ -n "$pat" ] || { echo "PAT vazio; nada gravado." >&2; exit 1; }

mkdir -p "$(dirname "$file")"
printf 'protocol=https\nhost=%s\nusername=%s\npassword=%s\n\n' "$host" "$user" "$pat" \
  | git -c credential.helper="store --file=$file" credential approve
unset pat
chmod 600 "$file"
echo "Gravado em $file (modo 600)."

echo
echo "Testando..."
mirror="${BUILD_CENTER_MIRROR:-$HOME/build-agent/$repo.git}"
if [ "$target" = agent ] && [ -d "$mirror" ]; then
  if GIT_TERMINAL_PROMPT=0 git --git-dir="$mirror" \
       -c credential.helper= -c credential.helper="store --file=$file" \
       ls-remote --heads origin develop >/dev/null 2>&1; then
    echo "OK: o agent autentica no Azure."
  else
    echo "FALHOU: o PAT nao foi aceito. Confira validade e o escopo Code (Read)." >&2
    exit 1
  fi
else
  if GIT_TERMINAL_PROMPT=0 git ls-remote --heads \
       "https://$host/$org/$project/_git/$repo" develop >/dev/null 2>&1; then
    echo "OK: autenticado."
  else
    echo "FALHOU: o PAT nao foi aceito. Confira validade e escopos." >&2
    exit 1
  fi
fi
