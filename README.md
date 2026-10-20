# Flex Direct

Gestão local, experimental e independente do **Ubiquiti USW Flex Mini**. A aplicação fala diretamente com o switch pelo protocolo de inform e por um canal de provisionamento TLS exposto temporariamente no firmware de fábrica.

![Painel principal](docs/screenshots/02-dashboard.png)

O projeto não usa uma conta ui.com, uma consola ligada ao switch ou uma instância UniFi Network. O switch e esta aplicação são os componentes necessários para gerir VLANs de acesso por porta e port mirroring. Quando os dois estão em sub-redes diferentes, são necessários relays TCP/UDP genéricos para transportar os anúncios e os informes.

> **Estado validado:** USW Flex Mini com firmware 2.1.6.762. Em 20 de outubro de 2026 foi executado no hardware o ciclo completo: descoberta, snapshot, reset de fábrica, reboot, redescoberta, adoção com uma chave própria e reposição da configuração anterior.

## O que funciona

- descoberta ativa por UDP unicast de IPs ou intervalos CIDR;
- recetor passivo de anúncios UDP quando o firmware só publica por broadcast;
- identificação por MAC, IP, modelo, firmware e estado de fábrica;
- adoção de um switch já em estado de fábrica, sem ui.com nem consola;
- reset de fábrica remoto de um switch atualmente gerido pela aplicação;
- snapshot automático antes do reset;
- redescoberta automática depois do reboot;
- troca da chave pública de fábrica por uma chave privada própria;
- reposição automática do snapshot e confirmação pelo cfgversion devolvido pelo switch;
- VLAN de acesso (PVID) e nome por porta;
- uma sessão de port mirroring;
- proteção da porta de uplink;
- pré-visualização, snapshots e histórico de alterações;
- autenticação local, cookie HttpOnly, proteção CSRF e limite de tentativas.

## Independência da consola UniFi

A aplicação não contacta ui.com nem depende de uma instância UniFi Network. O fluxo de recuperação usa três mecanismos locais do próprio firmware:

1. anúncio UDP na porta 10001, usado para descobrir o switch e confirmar o estado de fábrica;
2. resposta inform cifrada, usada para gerir o equipamento e enviar o pedido de reset;
3. ligação TLS JSON na porta 22 do firmware de fábrica, usada uma única vez para indicar o URL de gestão e a chave pública de adoção.

Não é necessário instalar ou manter um controlador UniFi para operar o projeto. Os relays documentados abaixo são transporte de pacotes, não componentes de gestão.

## Arquitetura

    Browser
       |
       v
    Flex Direct (Docker)  <---- inform TNBU ----  USW Flex Mini
       |                          |
       |                          +---- UDP 10001 discovery
       |
       +---- data/state.json, snapshots e auditoria

O switch envia um envelope TNBU autenticado para o endpoint de inform. A aplicação prepara a configuração de gestão, entrega um novo system_cfg quando necessário e só apresenta uma alteração como aplicada quando o equipamento regressa com o cfgversion esperado.

## Início rápido

Requisitos: Docker com Compose. Para desenvolvimento, Node.js 20 ou superior; o projeto não tem dependências npm externas.

    git clone https://github.com/0raculo/usw-flex-mini-direct.git
    cd usw-flex-mini-direct
    cp .env.example .env

Exemplo de configuração:

    ADMIN_PASSWORD=uma-palavra-passe-longa-e-aleatoria
    INFORM_URL=http://192.168.1.22:8080/inform
    SWITCH_MAC=74:83:c2:0f:39:35
    AUTO_ADOPT=0
    DISCOVERY_ENABLED=1
    DISCOVERY_TARGETS=192.168.1.0/24
    DISCOVERY_LISTEN_ENABLED=1
    DISCOVERY_LISTEN_PORT=10001
    DISCOVERY_LISTEN_PUBLISH=10002

O INFORM_URL tem de ser alcançável pelo switch. A aplicação publica a interface em 8789/TCP e o recetor passivo de descoberta em 10002/UDP por omissão.

    docker compose up -d --build
    curl http://127.0.0.1:8789/api/health

Abra http://127.0.0.1:8789 e entre com ADMIN_PASSWORD.

Para desenvolvimento:

    npm test
    ADMIN_PASSWORD='uma-palavra-passe-longa-e-aleatoria' \
    INFORM_URL='http://127.0.0.1:8080/inform' \
    npm start

## Rede entre sub-redes

O switch validado está em 192.168.1.0/24 e a aplicação em 192.168.69.0/24. O firmware anuncia-se por broadcast e não respondeu à sondagem UDP unicast usada por alguns outros equipamentos. Por isso, além do relay dos informes, existe um relay UDP mínimo para transportar os anúncios.

Relay dos informes no host 192.168.1.22:

    [Unit]
    Description=USW Flex Mini inform relay
    Wants=network-online.target
    After=network-online.target

    [Service]
    Type=simple
    DynamicUser=yes
    ExecStart=/usr/bin/socat TCP4-LISTEN:8080,bind=192.168.1.22,range=192.168.1.96/32,reuseaddr,fork TCP4:192.168.69.176:8789
    Restart=on-failure
    RestartSec=5
    NoNewPrivileges=yes
    PrivateTmp=yes
    ProtectSystem=strict
    ProtectHome=yes

    [Install]
    WantedBy=multi-user.target

Relay dos anúncios UDP no mesmo host:

    [Unit]
    Description=USW Flex Mini discovery broadcast relay
    Wants=network-online.target
    After=network-online.target

    [Service]
    Type=simple
    ExecStart=/usr/bin/socat -u UDP4-RECVFROM:10001,broadcast,fork,reuseaddr UDP4-SENDTO:192.168.69.176:10002
    Restart=on-failure
    RestartSec=3
    NoNewPrivileges=yes
    PrivateTmp=yes
    ProtectSystem=strict
    ProtectHome=yes

    [Install]
    WantedBy=multi-user.target

As versões completas dos dois units estão em deploy/usw-flex-mini-direct-relay.service e deploy/usw-discovery-relay.service.

A aplicação também tenta sondagem unicast direta para os destinos DISCOVERY_TARGETS. O recetor passivo continua disponível em paralelo e é o caminho validado para o USW Flex Mini.

## Adotar um switch já de fábrica

1. Configure o relay UDP e confirme que o estado do switch aparece como **Estado de fábrica** na secção **Descobrir e recuperar**.
2. Clique em **Adotar**.
3. A aplicação abre o canal TLS JSON na porta 22 e entrega o INFORM_URL.
4. O primeiro inform de fábrica é autenticado com a chave pública do firmware.
5. A aplicação responde com uma chave própria e confirma a adoção no inform seguinte.

O estado de recuperação fica visível na interface e é persistido em data/state.json. Fechar o browser não interrompe o processo.

## Reset com recuperação automática

A ação **Reset e recuperar** exige que o switch esteja atualmente gerido pela aplicação e online. Não é possível autenticar o pedido de reset num switch cuja chave ou estado local se perderam.

1. A aplicação cria um snapshot com o motivo before-factory-reset.
2. No inform seguinte envia o comando setdefault autenticado.
3. O switch reinicia e volta ao estado de fábrica.
4. A aplicação acompanha os anúncios UDP pelo MAC e encontra o novo endereço, se necessário.
5. Entrega o URL de gestão pelo canal TLS de fábrica.
6. Recebe o primeiro inform com a chave pública e gera uma chave privada própria.
7. Confirma a adoção no inform seguinte.
8. Envia o snapshot anterior e só conclui quando o cfgversion do snapshot é confirmado.

![Descoberta](docs/screenshots/05-discovery.png)

![Recuperação concluída](docs/screenshots/06-recovery.png)

O ciclo real de validação terminou com o switch online, adotado por esta aplicação, com chave de fábrica desativada, firmware 2.1.6.762 e a configuração anterior restaurada.

## Interface

![Entrada](docs/screenshots/01-login.png)

![Painel principal](docs/screenshots/02-dashboard.png)

![Revisão de alterações](docs/screenshots/03-review.png)

![Port mirroring](docs/screenshots/04-mirroring.png)

As capturas são de uma instalação real e não mostram palavras-passe nem a chave de autenticação do switch.

## API local

A interface usa uma API JSON no mesmo processo. Depois do login, os pedidos usam o cookie de sessão e o cabeçalho X-CSRF-Token.

| Método e rota | Função |
|---|---|
| GET /api/health | Estado básico do serviço |
| GET /api/status | Identidade e contacto recente do switch |
| POST /api/login | Cria a sessão e devolve o token CSRF |
| GET /api/state | Estado completo, descoberta, recuperação e snapshots |
| POST /api/discovery | Executa uma nova varredura |
| POST /api/adopt | Adota um switch de fábrica, por inform ou pelo MAC/IP descoberto |
| POST /api/reset | Cria snapshot e arma reset com recuperação automática |
| POST /api/preview | Valida um rascunho e lista alterações |
| POST /api/apply | Aplica um rascunho previamente revisto |
| POST /api/snapshots/:id/restore | Coloca um snapshot em fila |

O endpoint /inform pertence ao protocolo do switch e não é uma API administrativa. A API local não disponibiliza tokens de longa duração e não deve ser exposta diretamente à Internet.

## Limitações reais

- O reset remoto exige que o switch esteja atualmente gerido por esta aplicação. Um switch cuja chave se perdeu tem de ser encaminhado novamente para o inform ou recuperado a partir de uma cópia de data/.
- O firmware validado publica descoberta por broadcast. Entre sub-redes é necessário o relay UDP; a aplicação não recebe broadcast de outra LAN através do Docker sem esse transporte.
- Não há upload ou flash de firmware na aplicação. A versão instalada pode ser consultada, mas upgrade continua a exigir um mecanismo externo compatível.
- O USW Flex Mini expõe PVID/VLAN nativa por porta, mas não permite configurar VLANs marcadas ou um modo trunk geral pela aplicação validada.
- STP e RSTP não são configuráveis no hardware validado, apesar de aparecerem em algumas interfaces UniFi.
- IGMP snooping não é configurável neste modelo.
- Port mirroring suporta uma sessão e não pode usar a porta de uplink como destino.
- A porta 1 é tratada como uplink protegido para preservar a gestão; o projeto não modifica a sua VLAN nem a usa como destino de mirroring.
- Os snapshots cobrem a configuração de portas. Não incluem firmware, credenciais do antigo controlador, DHCP ou configuração externa da rede.
- O canal de recuperação depende de o firmware de fábrica manter a porta 22/TLS acessível. Não existe fallback por SSH normal no modelo validado.
- O relay de informes está restrito à origem 192.168.1.96/32 no exemplo. Se o DHCP mudar o IP durante um reset, a reserva ou a regra do relay tem de ser atualizada.
- A interface usa HTTP local. Para acesso fora de uma LAN ou VPN de confiança, coloque-a atrás de um proxy TLS com autenticação adicional.

## Segurança e dados locais

O volume data/ contém material sensível:

- state.json: configuração, identidade do switch, chave privada de gestão e estado da recuperação;
- session-secret: segredo usado para assinar sessões;
- snapshots/: cópias das configurações antes de aplicar ou reiniciar;
- audit.jsonl: eventos de login, descoberta, reset, adoção e reposição.

Mantenha permissões restritas, com 0700 na pasta e 0600 nos ficheiros. Não publique data/ no repositório, em anexos ou em logs. Faça backup conjunto de state.json e snapshots/ antes de testes destrutivos.

O fluxo de fábrica usa as credenciais públicas ubnt/ubnt e a chave pública do firmware apenas durante a adoção inicial. A chave privada criada depois nunca aparece na interface, no README ou nos eventos de auditoria.

## Testes

    npm test

A suite atual tem 16 testes e cobre:

- codificação e descodificação TNBU em AES-GCM e AES-CBC;
- política de VLAN e proteção do uplink;
- mirroring e confirmação por cfgversion;
- parser V1/V2 e TLVs de estado de fábrica;
- expansão de CIDR e sondagem UDP unicast;
- recetor passivo de anúncios;
- payload TLS JSON do canal de fábrica;
- ciclo HTTP completo de reset, descoberta, TLS, adoção, chave própria e reposição do snapshot.

No hardware de referência foram validados manualmente:

- descoberta do anúncio de fábrica por relay UDP;
- snapshot antes do reset;
- envio de setdefault e reboot;
- redescoberta do mesmo MAC;
- abertura do canal TLS e primeiro inform com chave de fábrica;
- troca para chave própria e confirmação da adoção;
- reposição do snapshot e cfgversion;
- recuperação do relay de informes;
- estado final online e configurado após o ciclo.

## Referências

- [Ubiquiti USW Flex Mini — downloads e firmware](https://ui.com/download/software/usw-flex-mini)
- [morluto/rea](https://github.com/morluto/rea) — ferramentas de análise e engenharia inversa que ajudaram a investigação;
- [lucavb/open-unifi](https://github.com/lucavb/open-unifi) — documentação pública do protocolo inform e do ciclo de vida de reset;
- [HostiFi discovery tool](https://github.com/HostiFi/hostifi-device-discovery-tool-releases) — referência do canal TLS JSON do Flex Mini;
- [finngineering/usw-flex-mini](https://github.com/finngineering/usw-flex-mini) — notas de hardware e mirroring;
- [datasheet do USW Flex Mini](https://dl.ui.com/ds/usw-flex-mini_ds.pdf).

O protocolo foi implementado a partir de observação do equipamento e documentação pública. Este projeto não é afiliado à Ubiquiti. Licença MIT; consulte [LICENSE](LICENSE).
