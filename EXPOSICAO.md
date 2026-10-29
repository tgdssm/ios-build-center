# Expor o Build Center — o que custa cada caminho

Isto aqui é uma pessoa, um Mac mini e um colega que precisa de build. Nada do
que está escrito abaixo pressupõe empresa, time de infra ou processo. Onde a
palavra "organização" ou "team" aparecer em algum painel, é só um rótulo que a
ferramenta pede — você é o único membro.

Estado da máquina (verificado em 2026-10-28):

- `cloudflared`, `tailscale`, `ngrok`: **nenhum instalado**
- Remote Login / Screen Sharing: não configurados por mim; não toquei
- O agent escuta em `127.0.0.1:8787` e não responde nem pela LAN
  (`http://<ip-da-maquina>:8787` → conexão recusada)

Nada está exposto hoje.

---

## A única coisa que eu faria antes de expor

Criar uma segunda conta de usuário no macOS, sem admin, e rodar o agent nela.

System Settings → Users & Groups → Add User → "Standard" (não "Administrator").
Dois minutos. Não é infraestrutura, é um checkbox.

O motivo é concreto. `flutter build ipa` executa os build phases do Xcode, o
`Podfile` e os scripts da branch. Quem controla a branch controla esse código.
Hoje ele roda como você, que é admin: alcança suas chaves SSH, seu keychain,
`~/Documents`, seus tokens do Azure. Numa conta separada, alcança o que aquela
conta tem — o checkout e os secrets de dev/hml/stg, que é exatamente o escopo.

A escolha limitada de branch e ambiente protege o *protocolo*. Ela não sandboxa
o *build*. A conta separada é o que fecha essa diferença, e é barata.

---

## Opção A — Cloudflare Tunnel + Access  (a que eu escolheria)

`builds.seudominio.com` → Cloudflare manda um código no e-mail do colega → só
então aparece o Build Center, que ainda pede o código dele.

- Saída apenas: o Mac abre a conexão. Nada entra pelo roteador, nenhuma porta
- Você tira o acesso dele pelo painel, sem tocar no Mac e sem estar em casa
- URL estável, sobrevive a restart

Setup: `brew install cloudflared`, `cloudflared tunnel login`, criar o túnel,
apontar o DNS, e uma policy do Access com **um** e-mail — o dele. O painel vai
pedir um "team name" na primeira vez; é o subdomínio da sua conta, não uma
empresa.

Precisa de um domínio no Cloudflare. Se você não tem, um `.com` sai por ~R$60/ano
e é a única coisa que se paga aqui — o Access é free.

Meia hora, contando a propagação do DNS.

## Opção B — quick tunnel (`cloudflared tunnel --url`)

Um comando, sem domínio e sem conta, devolve uma URL `*.trycloudflare.com`.

**Não use para a viagem.** Sem o Access na frente, o que separa a internet do seu
Mac mini é só o código de 16 caracteres do app. Sem lista de quem pode, sem
revogar, sem saber quem entrou. E a URL não é segredo: hostnames assim vazam em
Certificate Transparency e em scanner.

Serve para uma coisa: um teste de dez minutos com você olhando, e
`launchctl bootout` depois.

## Opção C — Tailscale Funnel

`tailscale funnel --bg 8787` publica a porta numa URL HTTPS pública e estável,
no formato `maquina.tailnet.ts.net`, com certificado Let's Encrypt renovado
sozinho. O Tailscale instala **só na sua máquina**: quem acessa abre no
navegador, sem instalar nada e sem entrar na sua rede.

- grátis, e não precisa de domínio
- URL fixa, sobrevive a reboot
- só a porta declarada atravessa; o resto do Mac não é alcançável por ali

O que falta aqui é o porteiro: não há tela de identidade antes do painel, então
a barreira é o login. É por isso que o segundo fator deixa de ser opcional
nesta opção.

Desligar tudo, de qualquer lugar:

```bash
tailscale funnel --https=443 off
```

Um porém que só aparece em rede corporativa: `ts.net` é domínio de ferramenta de
acesso remoto, e parte das empresas bloqueia essa categoria inteira. Se o DNS do
trabalho do seu colega recusar o nome, nenhuma configuração sua resolve — aí a
opção A, com domínio próprio, é o caminho.

## Opção D — Tailscale dentro da tailnet

O colega instala o Tailscale, entra na sua rede, abre `http://mac-mini:8787`.
Nenhuma URL pública existe.

Mais fechado que A em exposição. O porém: entrar na sua tailnet dá a ele alcance
de **rede** ao Mac, não só à porta 8787. Dá para prender com uma ACL
(`dst: mac-mini:8787`), mas o default é aberto e a ACL é você que escreve.

Boa se ele já usa Tailscale. Se não, A dá menos trabalho para ele e menos
alcance dentro da sua casa.

---

## Ordem

1. Conta de usuário separada, sem admin
2. Aceitar o PLA pendente em developer.apple.com, criar o
   certificado de distribuição e a chave da App Store Connect
3. Um upload manual para o TestFlight **daquela conta**, com você presente
4. Escolher a exposição, e um build inteiro pela URL, ainda com você aqui
5. Viajar

O passo 3 é o que não dá para pular: é o que prova que a cadeia
certificado → perfil → upload funciona naquela conta, enquanto você ainda pode
digitar uma senha de keychain.
