# iOS Build Center — protótipo

Central remota mínima de builds iOS para **um** Mac mini pessoal: o desenvolvedor remoto
escolhe branch + ambiente numa página web e o Mac executa o tooling de build que já existe
no projeto. Sem SSH, sem terminal, sem acesso ao filesystem, sem porta aberta no roteador.

> **Estado: protótipo funcional com backend de build simulado.** Toda a mecânica (auth, fila,
> worktree isolado, estágios, logs, cancelamento, auditoria, recuperação) está implementada e
> testada ponta a ponta. O que falta é apontar os passos de build para o tooling real do
> projeto — ver [Pendente](#pendente-investigação-no-projeto-real).

## Arquitetura

```
  dev remoto ─┐                   tudo que a requisição PODE dizer:
  dono ───────┤                   { branch, environment, buildName, buildNumber }
              │                   nunca um comando, um caminho ou uma flag
              ▼
   [ caminho de exposição ]       Funnel · Tunnel+Access · nada
              │                   conexão de SAÍDA: o Mac não abre porta
 ═════════════▼═══════════════════════════════════════════════  fronteira
   127.0.0.1:8787 — um processo Node, zero dependência
 ═════════════╤═══════════════════════════════════════════════
              │
      scrypt + TOTP ─► papel dentro do cookie assinado ─► throttle por IP
              │
              ▼
        config.json  ── programa: caminho absoluto + lista de args
     (só o dono       ── branch: tem que casar a allowlist de regex
      escreve)        ── ambiente: tem que existir aqui
              │
              ▼
     fila, 1 por vez ──► git worktree --detach <sha>
                                    │
                         código da branch roda aqui:
                         não confiável, isolado do checkout,
                         stdin em /dev/null — não consegue pedir senha
                                    │
                                    ▼
                            .ipa  ──►  TestFlight
```

O processo escuta **apenas** em `127.0.0.1`. Como o tráfego de fora chega até ele é uma
escolha separada e deliberada — Tailscale Funnel, Cloudflare Tunnel com Access, ou nada.
As opções e o que cada uma custa estão em [`EXPOSICAO.md`](EXPOSICAO.md). **Nada vem
exposto por padrão.**

Um único processo, sem dependências npm, sem banco de dados. O Mac **nunca** aceita conexão
de entrada: quem fala com a internet é o `cloudflared`, que abre a conexão de dentro para fora.
O servidor só escuta em `127.0.0.1`.

## Arquivos

| Arquivo | Papel |
| --- | --- |
| `src/server.js` | HTTP, sessão, CSRF, rate limit, API, SSE |
| `src/runner.js` | Pipeline: disco → mirror → fetch → worktree → passos → limpeza |
| `src/git.js` | Mirror, listagem de branches, resolução de commit, worktree |
| `src/exec.js` | `spawn` com argv (nunca shell), kill por grupo de processos |
| `src/store.js` | Jobs, histórico, logs, auditoria JSONL, recuperação pós-reboot |
| `src/auth.js` | scrypt + cookie HMAC + throttle de login |
| `src/redact.js` | Máscara de tokens/chaves/paths pessoais nos logs |
| `src/config.js` | Carrega e **valida** o config; define o que pode ser executado |
| `public/` | UI (sem framework, sem CDN, CSP restritiva) |
| `ops/*.plist` | LaunchAgents do agent e do túnel |
| `mock/step.sh` | Passo simulado, usado pela demo |

## Rodar a demo

```bash
scripts/demo.sh
```

Ele monta tudo em `./.demo`: um repositório git de brinquedo com quatro branches, um config
com os caminhos **da sua máquina**, e uma conta de acesso. No fim, imprime o comando para
subir o painel e as credenciais.

A demo usa a porta **8788**, não a 8787 — assim ela roda ao lado de uma instalação real sem
derrubar nada. Os passos de build são simulados por `mock/step.sh`, então não precisa de
Xcode, certificado nem projeto Flutter.

Para ver uma falha, crie um arquivo `FAIL_development` numa branch do repositório de
brinquedo: o passo simulado lê isso e sai com erro.

**Não use a config da demo em produção** — o código de acesso está no repositório, não há
segundo fator, e os cookies não exigem HTTPS.

## Configuração real

```bash
cp config.example.json config.json
node src/useradd.js --owner  # você: pede build e troca o token do repositório
node src/useradd.js          # o dev remoto: só pede build
```

O código de acesso é digitado sem eco e nunca é guardado — o `config.json` fica só com
o scrypt dele. Rodar de novo com o mesmo nome troca o código dessa pessoa.

### Como entrar

O login tem três campos:

| Campo | O que é |
| --- | --- |
| Usuário | o nome que você deu no `useradd` |
| Código de acesso | o código que você escolheu ali |
| Código do app autenticador | seis dígitos, trocam a cada 30s |

**Antes do primeiro login, cadastre o segundo fator.** O `useradd` imprime um segredo
de 32 caracteres e uma URI `otpauth://`. Qualquer app TOTP serve — Google
Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden, ou o app Senhas
do próprio macOS/iOS.

Na entrada manual do app, cole **apenas o segredo de 32 caracteres**. A URI
`otpauth://` serve para apps que leem URI ou QR code.

Cadastre **antes de fechar o terminal**: depois disso o segredo só existe dentro do
`config.json`, e não há comando para mostrá-lo de novo. Se perder, rode o `useradd`
outra vez para aquela conta — vai gerar código e segredo novos.

#### Os três erros que mais acontecem

1. **Digitar o segredo de 32 caracteres no painel.** Ele não vai ali. O painel quer os
   seis dígitos que o app passa a mostrar *depois* de cadastrado.
2. **No Microsoft Authenticator, escolher "Conta corporativa ou de estudante".** Esse
   fluxo espera uma URL de ativação da Microsoft e responde *"make sure that your url
   starts with https"*. O caminho certo é **"Outra conta (Google, Facebook etc.)"** →
   *"Ou inserir código manualmente"*.
3. **Relógio do aparelho dessincronizado.** O código é derivado da hora: se o relógio
   estiver errado, nenhum código bate. Os apps têm um ajuste para isso — no Microsoft
   Authenticator é *Verificação de hora para códigos*.

Código errado e segundo fator errado devolvem a **mesma** mensagem. Dizer qual dos dois
falhou confirmaria para quem está tentando que a outra metade já está correta.

#### Limitação conhecida: não há recuperação

Perdeu o acesso ao autenticador, perdeu o acesso à conta — e a única saída é rodar o
`useradd` **num terminal da máquina**. Não existe código de recuperação nem caminho
remoto, de propósito: qualquer um dos dois seria uma segunda porta para a mesma conta.

Se o painel vai ficar exposto enquanto você está longe da máquina, cadastre o mesmo
segredo em **dois dispositivos** — o celular e o gerenciador de senhas do computador,
por exemplo. É a diferença entre um aparelho quebrado ser um aborrecimento ou ser
perda total de acesso.

#### O interruptor

`security.requireTotp: true` recusa o login de qualquer conta sem segredo cadastrado.
É o que separa "painel em casa" de "painel na internet": ligue antes de expor, e nunca
antes de cadastrar, ou você fica de fora do próprio painel.

### Os dois papéis

| | `dev` | `owner` |
| --- | --- | --- |
| Pedir build nos ambientes liberados | sim | sim |
| Ver logs, histórico, cancelar | sim | sim |
| Trocar o token de leitura do repositório | **não** (403) | sim |
| Disparar um ambiente com `requiresRole: "owner"` | **não** (403) | sim |
| Ver se existe token e de quando é | **não** (o campo vem `null`) | sim |

Hoje **nenhum** ambiente usa `requiresRole` — Production inclusive está aberta aos dois.

O papel viaja dentro do cookie assinado, não no corpo da requisição: um `dev` não tem
como se declarar `owner`. O padrão de quem não declara papel é `dev` — virar dono tem
de estar escrito, nunca ser herdado por descuido.

### `requiresRole` por ambiente

Um ambiente pode exigir um papel mínimo:

```json
"prod": { "label": "Production", "enabled": true, "requiresRole": "owner", ... }
```

**Production está liberada para os dois papéis**, por decisão do dono da máquina: o
destino é o TestFlight, não a App Store.

O mecanismo `requiresRole` fica disponível e testado, sem estar em uso. Vale saber o que
ele cobriria: compilar `prod` exige o `secrets.prod.json` nesta máquina, e um build roda
scripts (`pubspec`, Podfile, build hooks) de uma branch que ninguém revisou — então quem
escolhe a branch escolhe código que roda ao lado desse arquivo. Com Production aberta,
isso vale para o dev remoto também.

A checagem, quando existe, é no servidor, a partir do papel dentro do cookie assinado. A
UI mostra 🔒 para quem não pode, mas esconder é cortesia — a recusa é o 403.

### Pré-voo

Bloco do painel, só para o `owner`, com um botão que confere **o que só apareceria no
minuto 40 de um build** — ou depois que o dono já estiver longe:

| item | o que quebra se estiver errado |
| --- | --- |
| Acesso ao repositório | `fetching`, logo no começo |
| Certificado Apple Distribution | `exportArchive`, depois de compilar tudo |
| Perfis de provisionamento | idem |
| Chave `.p8` da App Store Connect | o upload não roda sem humano |
| Keychain de login sem timeout | `codesign` travaria |
| Sono da máquina | o painel some quando ninguém está usando |
| Espaço em disco | build recusado antes de começar |
| Secrets por ambiente | o arquivo não é injetado no worktree |
| Último envio ao TestFlight | prova de que a cadeia inteira já funcionou |

O módulo [`src/preflight.js`](src/preflight.js) **só lê**. Não conserta, não pede senha
e não guarda segredo: cada item vermelho mostra o comando ou a tela que resolve, porque
o conserto é sempre decisão de quem é dono do Mac. Do `secretsFile` ele lê apenas os
**nomes** das chaves, nunca os valores.

### Nada aqui consegue pedir senha

É garantia estrutural, não cuidado: o `stdin` de todo processo filho é `/dev/null`
(`stdio: ['ignore', 'pipe', 'pipe']` em `exec.js`). Uma ferramenta que tenta ler senha
recebe EOF e falha, em vez de travar o build esperando alguém que não existe.

Por isso **não existe, e não deve existir, campo de senha neste painel** além do código
de acesso. Senha de sudo num formulário web transformaria isto num shell remoto com
root na máquina pessoal. E senha de Apple ID não funcionaria de todo jeito: 2FA. O
caminho correto para o upload sem humano é a chave `.p8`, que é o item do pré-voo.

Quando um passo falha *e* o log tem marca de prompt (`password:`, `user interaction is
not allowed`, `terminal prompts disabled`...), o agent escreve no log que algo tentou
pedir interação e manda rodar o pré-voo — em vez de deixar o erro cru da ferramenta.

### Trocar o token do repositório pela web

O PAT do Azure expira. Se isso acontecer no meio da viagem, sem esse painel a única
saída seria um terminal no Mac mini — exatamente o que este projeto existe para não
precisar. Então o `owner` tem um cartão no fim da página, **Acesso ao repositório**,
onde cola um PAT novo.

O que esse endpoint pode fazer é curto de propósito:

- escreve **um** arquivo, `~/build-agent/git-credentials`, que é o store do agent.
  Nunca o `~/.git-credentials` da sua conta;
- testa o token antes de gravar, contra um arquivo temporário, e só promove por
  `rename` se o `ls-remote` passar. **Um token errado não derruba o que estava
  funcionando** — que é o oposto do que o helper `store` faz sozinho, apagando a
  entrada no primeiro 401;
- não registra o valor em log nenhum, não devolve, não guarda em memória depois da
  chamada e não existe rota que leia o arquivo de volta;
- 5 tentativas recusadas por IP e o endpoint fecha por 10 minutos.

### Passos de build

Cada ambiente declara uma lista de passos. **O config é o único lugar que decide o que pode
ser executado** — a requisição HTTP nunca contribui com um programa, um path ou uma flag.
`program` tem de ser caminho absoluto; `args` é um array (nunca uma string de shell).

Placeholders disponíveis em `args` e em `env`: `{{worktree}}`, `{{artifacts}}`, `{{archive}}`,
`{{export}}`, `{{branch}}`, `{{environment}}`, `{{sha}}`, `{{shortSha}}`, `{{buildName}}`, `{{buildNumber}}`.

Fastlane (se o projeto já usa):

```json
{ "stage": "uploading", "program": "/opt/homebrew/bin/fastlane",
  "args": ["ios", "beta", "env:{{environment}}", "build_number:{{buildNumber}}"] }
```

xcodebuild direto:

```json
[
  { "stage": "installing_dependencies", "program": "/opt/homebrew/bin/pod", "args": ["install"] },
  { "stage": "archiving", "program": "/usr/bin/xcodebuild",
    "args": ["-workspace", "App.xcworkspace", "-scheme", "App-Staging", "-configuration", "Release",
             "-destination", "generic/platform=iOS", "-archivePath", "{{archive}}",
             "clean", "archive"] },
  { "stage": "uploading", "program": "/usr/bin/xcodebuild",
    "args": ["-exportArchive", "-archivePath", "{{archive}}", "-exportPath", "{{export}}",
             "-exportOptionsPlist", "ci/ExportOptions-staging.plist",
             "-authenticationKeyPath", "/Users/build/keys/AuthKey.p8",
             "-authenticationKeyID", "ABC123", "-authenticationKeyIssuerID", "..."] }
]
```

Com `destination: upload` no `ExportOptions.plist`, o próprio `-exportArchive` envia ao
TestFlight — sem `altool`, sem passo extra.

Script do próprio projeto (o caso mais provável, já que a tooling existe):

```json
{ "stage": "building", "program": "/bin/bash",
  "args": ["{{worktree}}/scripts/build.sh", "{{environment}}"] }
```

### Versão e build number

Os dois são **digitados por quem pede o build**, não calculados pelo agent.

Já foram automáticos: um contador interno escolhia o número sozinho, a partir de um
valor que eu tinha proposto num documento e ninguém confirmou. Os builds de teste
saíram com 300, 301, 302, 303 — números que não tinham relação nenhuma com o que havia
no repositório ou no TestFlight. Contador escondido que inventa valor é pior que campo
em branco, porque ninguém olha.

Agora o formulário pergunta, e ajuda a responder: ao escolher a branch, o painel lê o
`pubspec.yaml` **dela** (`GET /api/branch-version`, direto do mirror) e preenche os dois
campos com o que está escrito lá, dizendo de onde veio:

> No pubspec de develop: 5.1.1+253. Confira o build number — a Apple recusa número repetido.

Os valores viram `--build-name` e `--build-number`. São **valores, não flags**: o
servidor fecha o formato antes (`^\d{1,4}\.\d{1,4}\.\d{1,4}$` e inteiro positivo), então
nada que venha do navegador consegue virar argumento novo. Um `5.1.1 --obfuscate` é
recusado como versão inválida.

Se um build **com sucesso** já usou aquele número, o pedido é recusado com 409 na hora,
em vez de compilar 40 minutos para a Apple recusar o upload no fim.

Atenção: o agent compila a partir da **branch**, nunca do working tree de ninguém. Uma
alteração de versão que não foi commitada e enviada não existe para ele.

### Secrets

`secretsFile` aponta para um arquivo `KEY=value` legível só pela conta de build. Os valores
entram no ambiente dos passos e são **mascarados automaticamente nos logs**. O processo de
build recebe um ambiente mínimo construído do zero — ele não herda o ambiente do agent.

## Instalação no Mac

`scripts/install.sh` faz o trabalho mecânico. Rode **logado na conta que vai
hospedar o agent**:

```bash
APPLE_TEAM_ID=XXXXXXXXXX scripts/install.sh <diretorio-deste-codigo> <diretorio-do-projeto>
```

`APPLE_TEAM_ID` é obrigatório: ele entra nos `ExportOptions.plist` que o script gera, e um
valor errado assina pela conta errada — ou por nenhuma. O seu está em developer.apple.com,
em **Membership details**.

Se o repositório for Azure DevOps, `scripts/set-repo-credential.sh` também pede três
variáveis, pelo mesmo motivo de não haver nada chumbado no código:

```bash
AZURE_ORG=sua-org AZURE_PROJECT=seu-projeto AZURE_REPO=seu-repo \
  scripts/set-repo-credential.sh agent
```

Ele cria `~/build-center` (código) e `~/build-agent` (estado, logs, workspaces,
secrets, export-options), copia `secrets.{dev,hml,stg}.json` do checkout —
**prod fica de fora de propósito** —, gera os `ExportOptions.plist` por flavor,
escreve o LaunchAgent e registra no launchd.

`--no-service` como terceiro argumento instala tudo mas **não** registra o
serviço, para quem quer conferir o plist antes.

Ele não pede sudo, não abre porta nenhuma, não instala túnel e não toca em
arquivo fora desses dois diretórios.

O que continua sendo seu:

1. **Conta macOS dedicada, sem privilégios de admin** (ex.: `build`). Esta é a
   medida de segurança mais importante — ver abaixo e `EXPOSICAO.md`.
2. `node src/useradd.js --owner` (você) e `node src/useradd.js` (o dev remoto).
3. Chave SSH/PAT **somente leitura** do repositório, só nessa conta.
4. Certificado de signing + chave da App Store Connect no keychain dessa conta.
5. Exposição externa — as três opções e o que cada uma custa estão em
   [`EXPOSICAO.md`](EXPOSICAO.md). Nada vem exposto por padrão.
6. Energia: desativar sleep. FileVault: ou auto-login dessa conta, ou aceitar que
   um reboot exige alguém logar.

### `toolchainPath`

O build **não** herda o PATH do shell de login: ele recebe um PATH mínimo
(`/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`). Ferramentas
fora disso são declaradas no config:

```json
"toolchainPath": ["~/.rbenv/versions/3.3.4/bin"]
```

Neste Mac isso é obrigatório: o CocoaPods vem do rbenv, e sem essa linha o
`flutter build ipa` falha em *archiving* com "CocoaPods not installed".

## Fronteira de segurança

**O desenvolvedor remoto consegue, pela API:** pedir build de uma branch que já existe no
repositório e que casa com `branchAllowPatterns`, num ambiente marcado `enabled`; cancelar o
próprio build; ler os logs sanitizados.

**Não consegue, pela API:** executar comando, enviar path, flag ou variável; escolher
programa; ler arquivo; sair do worktree; rodar dois builds ao mesmo tempo; usar Production
(bloqueado no config); usar SSH, terminal ou Screen Sharing — nada disso existe nesta
superfície.

**Consegue, via conteúdo da branch:** executar código arbitrário, porque build de iOS executa
código do repositório por desenho (run scripts, `Podfile`, plugins SPM, `xcconfig`). **Isto não
tem solução dentro da aplicação.** A contenção é o sistema operacional:

- conta macOS dedicada e sem admin → o `$HOME` do dono (modo `700`) fica inacessível, assim
  como suas SSH keys, seu keychain e seus documentos;
- nenhum secret pessoal no `secretsFile`;
- chave da App Store Connect com escopo só do app em questão — ela **é** exfiltrável por quem
  controla a branch, então rotacione ao voltar;
- o agent nunca passa o próprio ambiente adiante, e `git` roda com `GIT_TERMINAL_PROMPT=0`.

Resumo honesto: isto reduz "RCE no seu Mac pessoal" para "RCE numa conta descartável com
credenciais de build". Para uma máquina pessoal e um time pequeno, é a troca proporcional.

### Proteções da API implementadas

| Risco | Tratamento |
| --- | --- |
| URL descoberta por terceiro | Login próprio: scrypt + segundo fator obrigatório. Uma camada de identidade na frente (ex.: Cloudflare Access) é opcional e **não** vem configurada |
| Segundo fator | TOTP (RFC 6238) sobre `node:crypto`, por conta. `security.requireTotp` recusa quem não cadastrou |
| Reuso de código TOTP | O contador já gasto fica marcado até expirar; o mesmo código não entra duas vezes |
| Enumeração de usuário | Nome inexistente paga o mesmo scrypt, contra oráculo de tempo no login |
| Brute force de código | Throttle por IP (5 tentativas / 15 min) |
| Dev trocando o token do repo | Rota exige papel `owner`, lido do cookie assinado (403 + auditoria) |
| Token colado errado | Validado contra o servidor num arquivo temporário; só promovido por `rename` |
| Força bruta de token | 5 recusas por IP fecham a rota por 10 min (contador separado do login) |
| CSRF | Cookie `SameSite=Strict` + header `x-bc-csrf` por sessão |
| Replay / duplo clique | Job duplicado rejeitado (409) + intervalo mínimo por usuário |
| Spam de builds | Fila limitada (`maxQueue`) + `minSecondsBetweenBuilds` |
| Builds concorrentes | Worker único; `maxConcurrentBuilds` não é configurável acima de 1 |
| Injeção por branch | Regex conservadora + branch tem de existir no mirror + argv, nunca shell |
| Injeção por versão / build number | Formato fechado no servidor (semver puro, inteiro) antes de virar `--build-name` / `--build-number` |
| Build number repetido | 409 na hora se um build com sucesso já usou aquele número |
| Ambiente restrito a um papel | `requiresRole` no ambiente, checado no servidor (403 + auditoria). Não está em uso hoje |
| Vazamento em log | `redact.js` (tokens, JWT, chaves privadas, URLs com senha, `$HOME`) |
| XSS na UI | CSP sem `unsafe-inline`; DOM construído por `textContent` |

### Recuperação

- **Build quebrado** → job vira `failed` e o workspace **fica**, com o `.xcarchive` e os
  Pods, para você abrir no Xcode. É removido na próxima execução, pela retenção de
  `keepWorkspaces`. (Antes era apagado na hora, justo quando a evidência importava.)
- **Credenciais de git** → o agent usa um store só dele
  (`~/build-agent/git-credentials`) e nunca lê nem escreve o `~/.git-credentials` da
  conta. O helper `store` **apaga** a entrada quando o servidor responde 401, então sem
  esse isolamento uma falha do agent derruba o git do dono da máquina — o que aconteceu
  uma vez durante os testes. O agent precisa do PAT dele, somente leitura.
- **PAT expirado durante a viagem** → o `owner` entra no painel e cola um novo no cartão
  *Acesso ao repositório*. Sem terminal, sem SSH. Enquanto não trocar, a lista de branches
  continua vindo do mirror local, marcada em âmbar como desatualizada.
- **Reboot / processo morto** → LaunchAgent sobe de novo; no boot, qualquer job que estava
  `running` é marcado `failed` ("o agent reiniciou"), nunca fica preso.
- **Disco cheio** → checagem antes de começar; se faltar espaço, limpa workspaces antigos e
  só então falha. A limpeza só remove diretórios com nome de UUID dentro de `workspacesRoot`.
- **Passo travado** → timeout por passo, `SIGTERM` e depois `SIGKILL` no grupo de processos.
- **Cancelamento** → mata o grupo do processo filho daquele job. Nunca `killall` por nome.

## Escopo

Isto **não** é um CI. Não tem plugins, matriz, artefatos versionados, webhooks nem workers.
São ~1.500 linhas (UI incluída) para: 1 Mac, 1 projeto, 1 build por vez, poucos ambientes, destino TestFlight.
