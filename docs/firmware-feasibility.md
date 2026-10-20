# Firmware próprio para o USW Flex Mini: viabilidade

Análise inicial concluída em 2026-10-20. Equipamento de referência: USW Flex Mini com firmware oficial **2.1.6.762**, MAC terminado em 39:35 e uplink na porta 1.

## Decisão executiva

- **Hoje:** VLAN nativa/PVID, nomes de porta, isolamento, flow control, storm control, velocidade/duplex e uma sessão de port mirroring são configuráveis pela aplicação.
- **Hoje:** o firmware oficial **não expõe** membros tagged por porta, STP/RSTP nem IGMP/MLD snooping.
- **Hardware:** o switch Realtek RTL8367RB tem recursos para 802.1Q, snooping e mirroring. Isso torna as funcionalidades tecnicamente plausíveis num firmware próprio, mas não significa que o firmware instalado as suporte.
- **Firmware próprio:** requer um driver SMI para o switch, inicialização da placa, implementação e teste da pilha L2, imagem compatível e um caminho de recuperação.
- **Bloqueio atual:** não existe uma cadeia de arranque e recuperação suficientemente segura para escrever um firmware experimental. A aplicação executa verificação de assinatura RSA e não foi encontrado um caminho de rede que force o loader nem um mecanismo de recuperação sem consola.
- **Conclusão:** implementar tagged VLAN, snooping e controlo STP num firmware próprio é um projeto viável em investigação, mas continua **bloqueado para utilização real** enquanto não houver recuperação física ou uma cadeia de flash verificada.

## Matriz de capacidade

| Objetivo | Firmware oficial 2.1.6 | Chip RTL8367RB | Firmware próprio |
|---|---|---|---|
| VLAN nativa/PVID por porta | Sim, implementado | Sim | Sim, após driver e tabela de membros |
| VLAN tagged 802.1Q por porta | Não exposto | Sim | Possível; exige controlo de membros, PVID e egress untagged/tagged |
| STP/RSTP funcional | Não exposto | Suporta operações de forwarding/FDB/RMA | Possível, mas a máquina de estados tem de correr na MCU |
| IGMP/MLD snooping | Não exposto | Sim | Possível; exige gestão de grupos, aging e integração com uplink |
| Port mirroring | Sim, uma sessão | Sim | Sim |
| Upgrade pela webapp | Não implementado | — | Só depois de assinatura e recuperação validadas |
| Recuperação sem consola | Reset pela app, depois TLS de fábrica | — | Não demonstrada para firmware alternativo |

## O que o firmware oficial expõe

A aplicação ARM contém uma lista limitada de chaves de configuração. As chaves relacionadas com portas são:

    switch.managementvlan
    switch.port.N.autoneg
    switch.port.N.duplex
    switch.port.N.egress_rate_limit_kbps
    switch.port.N.flowctrl
    switch.port.N.isolation
    switch.port.N.mirror_port
    switch.port.N.opmode
    switch.port.N.pvid
    switch.port.N.speed
    switch.port.N.status
    switch.port.N.stormctrl.bcast
    switch.port.N.stormctrl.mcast
    switch.port.N.stormctrl.ucast

Não foram encontrados setters de tagged membership, STP, RSTP, IGMP ou MLD snooping no caminho de configuração observado. A presença de strings STP/IGMP na extensão ESP32 do pacote multi não prova suporte na aplicação ARM deste modelo.

## Imagens analisadas

| Versão | SHA-256 da imagem |
|---|---|
| 2.1.6 | 40c585ee96e10eff782e37f033b8f8124e070e5b761d3e73931aa546a2bd25da |
| 2.1.3 | 8be072eaf24826a69649c2a4ade4ead591cbddb7221b7969a7375c5a03d9887b |

Componentes da 2.1.6:

| Componente | Tipo | Offset | Tamanho | SHA-256 |
|---|---:|---:|---:|---|
| Loader | 0x12 | 8 | 65 292 | 4bb06698a46ff232a04587b0b0eae1411744cbc586338c689199dfa974281b9d |
| Aplicação ARM | 0x11 | 65 344 | 446 336 | 534ce53d03c3920fef11ceb80a5cf884f09e29fe9515b3fcab0cbcbefd14b85e |
| Assinatura | 0x15 | 511 796 | 256 | b050e67146101eca474cd29a46619b1134d7ffd72d360568531447342ec50bb0 |

A aplicação tem sete segmentos; todos os CRC32 da versão 2.1.6 conferem. O pacote completo tem 2 747 888 bytes. O bloco reconhecido pela aplicação termina em 512 084 bytes; os 2 269 596 bytes seguintes são uma extensão opaca com o marcador usmini2, associada ao alvo ESP32 do pacote multi.

O formato exterior confirmado pelo parser é:

- magic aa5555aa;
- protocolo 0002;
- componentes com magic 11223344;
- segmentos com magic 01020304 e CRC32;
- assinatura RSA de 2048 bits no componente 0x15.

O parser reproduzível está em [src/firmware-image.mjs](../src/firmware-image.mjs) e o utilitário em [scripts/inspect-usmini-firmware.mjs](../scripts/inspect-usmini-firmware.mjs):

    node scripts/inspect-usmini-firmware.mjs imagem.bin --json
    node scripts/inspect-usmini-firmware.mjs imagem.bin --extract /tmp/usmini

## Cadeia de firmware e assinatura

A aplicação contém logs e lógica para descarregar uma imagem, distinguir imagens assinadas e não assinadas e reportar falhas de chave ou tamanho. Foram encontradas, entre outras, as strings:

    Skip Non-signed App
    SIGNATURE VERIFICATION ERROR
    Verify App signature ... OK!
    fwupgrade_get_firmware
    do_fwupgrade
    reporter_fw_url

O loader contém o caminho de upgrade e escrita na flash:

    Bootloader
    Illegal firmware header
    Segment CRC Error
    Write flash Firmware
    Get Firmware
    do_fwupgrade
    recovery_enable

Constantes observadas no loader:

| Região | Endereço | Limite |
|---|---:|---:|
| Aplicação | 0x10000 | 0x6d000 |
| TLS | 0x7d000 | — |
| Ambiente | 0x7e000 | — |
| Informação de imagem assinada | 0x7f000 | — |

A existência de validação de CRC no loader não demonstra que uma aplicação sem assinatura seja aceite. Pode haver uma verificação posterior, uma decisão no arranque, uma restrição da chave ou um caminho não alcançado pela análise estática. Não foi encontrado um pedido de rede suportado que faça o loader descarregar um URL arbitrário e escrevê-lo. Por isso, **não há evidência suficiente para tratar um loader alternativo como recuperável**.

O botão de reset, o canal TLS de fábrica e o inform permitem recuperar a aplicação oficial de fábrica. Não foi demonstrado nenhum destes caminhos depois de substituir a aplicação por uma imagem não assinada. Sem acesso físico à flash, um erro nessa escrita pode deixar o equipamento sem gestão.

## Método de engenharia inversa

- REA 6.7.0 foi usado para organizar a análise estática e o handoff para Ghidra. O trabalho foi feito sobre os binários de firmware de origem autorizada do próprio equipamento.
- A análise de firmware do REA requer Linux x64. No macOS, o comando de firmware devolveu capability_unavailable; por isso a extracção foi executada com Unblob em Linux, numa imagem fixa por digest.
- Unblob não reconheceu o formato exterior proprietário e marcou os blocos como UNKNOWN. O parser próprio reconheceu deterministicamente o header, componentes, segmentos e CRC. O resultado do Unblob não foi usado como prova de uma partição ou de um sistema de ficheiros.
- Ghidra foi usado para analisar o loader e a aplicação ARM, seguir referências às strings de upgrade e inspeccionar a escrita na flash. O REA não emula o firmware nem demonstra comportamento de arranque.
- A análise é estática. Não foi executado firmware alternativo no switch e não houve tentativa de bypass da assinatura.

## O que um firmware próprio exigiria

1. Mapear a interface entre a MCU, o RTL8367RB e a flash, incluindo SMI/MDIO, pinos, clocks e sequência de reset.
2. Escolher uma base licenciada e reproduzível. A presença de SDKs públicos não resolve por si só a licença de redistribuição nem a inicialização específica desta placa.
3. Implementar descoberta da topologia, tabela FDB, VLANs com PVID e memberships tagged/untagged, isolamento e mirroring.
4. Implementar uma máquina de estados STP/RSTP na MCU, com envio/recepção de BPDUs e transições de porta consistentes com o chip.
5. Implementar IGMP/MLD snooping, gestão de grupos, supressão de flood e aging, testando com uplink e clientes reais.
6. Manter inform/gestão local e uma API de configuração independente de ui.com.
7. Criar uma imagem assinada aceite pelo dispositivo, ou provar uma cadeia de arranque alternativa com rollback.
8. Ter um método de recuperação fora da aplicação: acesso à flash, boot ROM, consola de debug ou watchdog que restaure uma imagem conhecida.

Os pontos 1, 7 e 8 são os bloqueios materiais. Os restantes são trabalho de implementação e teste.

## Próximo passo seguro

Antes de qualquer imagem experimental, é necessária uma prova de recuperação física. O caminho proporcional é identificar a flash, confirmar se pode ser lida e escrita com um programador externo e guardar múltiplas cópias verificadas da imagem original. Só depois se pode testar um loader ou uma aplicação própria sem transformar o equipamento num tijolo.

Enquanto essa prova não existir, a aplicação deve continuar a usar o firmware oficial e limitar-se às operações que já valida. A aplicação não inclui upload nem flash de firmware.

## Limitações da investigação

- Não foi possível confirmar por execução qual é o ponto exacto de validação da assinatura.
- O loader mostra validação de header e CRC; a ausência de uma chamada de assinatura no caminho observado não prova ausência de validação noutro estágio.
- Não está mapeada a recuperação por hardware.
- Não há toolchain, BSP ou código-fonte oficial deste modelo.
- A capacidade do RTL8367RB não implica disponibilidade das mesmas operações no firmware atual.
- Um firmware próprio continua a ser um projeto de engenharia e validação de risco elevado, não uma simples alteração de configuração.

## Fontes

- [REA](https://github.com/morluto/rea): análise estática, handoff para Ghidra e limites da análise de firmware;
- [RTL8367RB datasheet](https://openwrt.org/_media/media/datasheets/switch/rtl8367rb-cg.pdf): capacidades de switching, VLAN, snooping e mirroring;
- [noodlefighter/rtl8367b-api-test](https://github.com/noodlefighter/rtl8367b-api-test) e [maxx-ukoo/rtl8367-controller](https://github.com/maxx-ukoo/rtl8367-controller): exemplos de acesso e controlo do switch Realtek;
- [zhai-dada/RTL8367-SDK](https://github.com/zhai-dada/RTL8367-SDK): referência de SDK, sem ter sido incorporado neste projeto;
- [jade.wtf — USW Flex Mini notes](https://jade.wtf/tech-notes/usw-mini/) e [finngineering/usw-flex-mini](https://github.com/finngineering/usw-flex-mini): notas públicas de hardware e comportamento.
