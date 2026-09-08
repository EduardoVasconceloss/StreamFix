# Experimento: controle de mídia pela mesma saída do gateway

## Objetivo

Testar se encaminhar as conexões TCP de controle de mídia do Discord pela saída do gateway faz a transmissão voltar a produzir e entregar vídeo, mantendo UDP direto. É um experimento local reversível, não uma correção comprovada nem uma migração para VPN.

## Evidência e hipótese

Na reprodução Windows → espectador no WSL, a captura produz quadros, mas o emissor registra zero quadros codificados, zero pacotes de vídeo e zero receptores. O espectador recebe áudio, mas não vídeo. Trocar a região da transmissão para US East e recarregar com Ctrl+R não resolveu; os logs registraram uma nova sessão e um servidor de mídia nos EUA.

Hipótese a testar: há uma diferença relevante entre a saída do gateway e a das conexões TCP de controle de mídia. Se alinhá-las for suficiente, o vídeo deve começar a ser codificado e recebido sem rotear UDP pelo proxy.

Alternativas ainda abertas: estado de assinatura do espectador, negociação de mídia ou uma condição do servidor envolvendo a origem do UDP. O experimento não pressupõe que o Discord passou a correlacionar TCP e UDP. Um resultado negativo não prova que VPN é necessária.

## Alteração delimitada

- Acrescentar os subdomínios de `discord.media` ao PAC existente, exclusivamente na build experimental e quando o roteamento estiver ativo. Não aceitar domínios parecidos, como `discord.media.example.com`.
- Reutilizar o roteador SOCKS local e a saída selecionada para o gateway. Registrar mudanças de saída durante a tentativa para não confundir resultados.
- Não alterar UDP, DNS do sistema, região escolhida, autenticação, conta, regras de firewall ou configuração de VPN. Preservar a regra de sistema para os demais destinos e o comportamento de roteamento desativado.
- Manter TLS ponta a ponta: o roteador só transporta bytes, sem interceptar certificados ou ler mensagens do Discord.
- Se o proxy recusar o destino de mídia, registrar explicitamente o fallback direto. Não descartar uma saída de gateway funcional apenas por essa recusa. Esse caso não testa a hipótese e deve ser classificado como inconclusivo.
- Não trocar o plugin do espectador no WSL: somente o emissor Windows recebe a build experimental.

## Instrumentação

Usar o prefixo temporário `[DEBUG-media-control]` no diagnóstico local. Registrar início, resultado do túnel, fallback, encerramento e totais de bytes nas duas direções, com identificador local da conexão. Identificar a saída por referência local, sem acrescentar credenciais, tokens, URLs completas, payloads ou identificadores de contas aos logs.

Verificar a resolução do PAC para o host de mídia e a passagem efetiva de conexões pelo roteador. A resolução do PAC ou a aceitação de SOCKS CONNECT, isoladamente, não comprova que o WebSocket autenticado funcionou. Se o controle de mídia ignorar o PAC do Electron, registrar essa limitação como resultado inconclusivo.

## Validação

1. Testar as regras de domínio, roteamento desativado, preservação de login/gateway e fallback. Esses testes validam o experimento, não reproduzem o defeito remoto do Discord.
2. Compilar com o checkout do mod realmente carregado pelo Discord Windows, preservando modificações existentes e uma cópia recuperável dos arquivos que serão substituídos.
3. Encerrar e abrir o Discord por completo para carregar a mudança no processo principal. Ctrl+R sozinho não é suficiente para garantir isso.
4. Repetir o mesmo compartilhamento e entrada do espectador, preservando região e demais configurações. Registrar o horário da tentativa e coletar somente sinais de mídia necessários, sem segredos.
5. Comparar contagem de receptores, quadros codificados, pacotes de vídeo enviados/recebidos e imagem efetivamente visível ao espectador.

### Interpretação

- **Funcionou:** o espectador vê vídeo, com quadros codificados e tráfego de vídeo positivos. Conferir que o controle utilizou a saída pretendida; restaurar a build anterior e repetir a comparação, se necessário para atribuir causalidade.
- **Hipótese não sustentada nesta reprodução:** controle comprovadamente estabelecido pela saída pretendida, mas vídeo continua zerado. Não extrapolar para a obrigatoriedade de VPN.
- **Inconclusivo:** proxy recusou ou caiu, houve fallback direto, o controle não atravessou o roteador, as saídas divergiram ou faltou evidência suficiente da conexão de controle.

## Reversão e limites

Guardar a versão anterior antes da aplicação e registrar quais arquivos foram substituídos. Reverter somente esses arquivos e reiniciar o Discord por completo. Não publicar release, fazer push, instalar drivers/VPN ou modificar o espectador. Instrumentação e regra experimental não devem ser promovidas à versão estável sem o resultado do teste e nova decisão.

## Plano de execução

Após revisão deste documento: localizar checkout e build ativos; preparar testes de roteamento; implementar a regra e os logs; executar testes e compilação; aplicar com backup; conduzir o teste comparativo com o usuário. A skill `writing-plans` referenciada por `brainstorming` não está disponível nesta sessão; este plano curto é o fallback explícito.
