#!/bin/bash
# Passo de build simulado. Recebe: <rotulo> <segundos>
set -euo pipefail
label="$1"; seconds="${2:-2}"
echo "[$label] iniciando em $(pwd)"
echo "[$label] branch=$BUILD_CENTER_BRANCH env=$BUILD_CENTER_ENVIRONMENT commit=${BUILD_CENTER_COMMIT:0:7}"
for i in $(seq 1 "$seconds"); do
  echo "[$label] progresso $i/$seconds"
  sleep 1
done
if [ -f "./FAIL_${BUILD_CENTER_ENVIRONMENT}" ]; then
  echo "[$label] erro simulado a pedido da branch" >&2
  exit 1
fi
echo "[$label] concluido"
