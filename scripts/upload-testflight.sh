#!/bin/bash
# Envia ao TestFlight o IPA gerado pelo build.
#
# Este script vive no repositorio do AGENT, nunca na branch do app: quem controla a
# branch nao controla o passo de upload nem as credenciais usadas aqui.
#
# Uso:   upload-testflight.sh <diretorio-com-o-ipa>
# Env:   ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEYS_DIR  (vem do secretsFile do agent)
set -euo pipefail

ipa_dir="${1:?uso: upload-testflight.sh <diretorio-com-o-ipa>}"

# O IPA vem antes das credenciais de proposito. "flutter build ipa" pode sair com
# codigo 0 mesmo quando o exportArchive falhou (falta de certificado, por exemplo):
# nesse caso o arquivo simplesmente nao existe. Checando as credenciais primeiro, o
# erro que aparece no log e "ASC_KEY_ID nao definido", que manda quem le para o lado
# errado. A ausencia do IPA e a causa real e precisa ser a primeira coisa dita.
if [ ! -d "$ipa_dir" ]; then
  echo "O build nao produziu $ipa_dir — o export falhou antes do upload." >&2
  exit 1
fi
# Sem array e sem mapfile de proposito. O macOS entrega bash 3.2 e nunca vai subir
# disso (licenca do bash 4), entao mapfile/readarray nao existem aqui — e "${#a[@]}"
# em array vazio ainda estoura com set -u no 3.2. Um contador e uma variavel fazem o
# mesmo trabalho e rodam em qualquer bash.
ipa=""
achados=0
while IFS= read -r encontrado; do
  ipa="$encontrado"
  achados=$((achados + 1))
done < <(find "$ipa_dir" -maxdepth 1 -name '*.ipa' -type f)

if [ "$achados" -eq 0 ]; then
  echo "Nenhum .ipa em $ipa_dir — o build compilou mas o export nao gerou pacote." >&2
  echo "Veja os erros de exportArchive acima; normalmente e certificado ou perfil." >&2
  exit 1
fi
if [ "$achados" -gt 1 ]; then
  echo "Mais de um .ipa em $ipa_dir; esperado exatamente um." >&2
  find "$ipa_dir" -maxdepth 1 -name '*.ipa' -type f | sed 's/^/  /' >&2
  exit 1
fi
echo "IPA: $(basename "$ipa") ($(du -h "$ipa" | cut -f1))"

: "${ASC_KEY_ID:?ASC_KEY_ID nao definido (configure o secretsFile do agent)}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID nao definido}"
: "${ASC_PRIVATE_KEYS_DIR:?ASC_PRIVATE_KEYS_DIR nao definido}"

echo "Validando pacote..."
API_PRIVATE_KEYS_DIR="$ASC_PRIVATE_KEYS_DIR" xcrun altool --validate-app \
  -f "$ipa" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "Enviando ao TestFlight..."
API_PRIVATE_KEYS_DIR="$ASC_PRIVATE_KEYS_DIR" xcrun altool --upload-app \
  -f "$ipa" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "Upload aceito. O processamento no App Store Connect leva alguns minutos."
