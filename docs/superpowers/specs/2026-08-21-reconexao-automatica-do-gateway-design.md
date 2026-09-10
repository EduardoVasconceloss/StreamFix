# Reconexão automática do gateway, sem Ctrl+R

## Problema

Hoje, depois que o Go Live é liberado, duas situações voltam a bloquear a sessão e exigem que a pessoa recarregue o Discord na mão (Ctrl+R):

1. **A internet do usuário oscila.** O Discord já reconecta o gateway sozinho nesses casos (`GatewayConnectionStore`, via `_handleClose`), sem nenhuma ajuda do plugin. O problema é que essa reconexão automática usa `resumeUrl` — um host regional (`gateway-us-east1-c.discord.gg`, por exemplo), não `gateway.discord.gg`. O roteador do StreamFix só cobre `gateway.discord.gg` e `remote-auth-gateway.discord.gg` por nome exato, então esse resume sai direto do IP real, sem passar pela saída. Um Ctrl+R "resolve" só porque um reload força uma conexão nova de verdade, sem `resumeUrl` herdado, que cai no host genérico (esse sim roteado).
2. **A própria saída (proxy gratuita ou Tor) morre no meio da sessão.** O processo principal já detecta isso (`dropExit`) e já busca uma substituta sozinho, mas não avisa ninguém: quem percebe que a sessão ficou bloqueada é o plugin, reagindo ao próximo `CONNECTION_OPEN`, e mesmo aí só recarrega até duas vezes por abertura do Discord (`MAX_RETRIES`). Depois disso desiste de vez.

Verificado ao vivo (DevTools, Discord com Equicord injetado, StreamFix ativo): `GatewayConnectionStore.getSocket()` devolve o objeto que fala o protocolo do gateway. Ele expõe:

- `_getGatewayUrl()`: `return null != this.resumeUrl ? this.resumeUrl : this.altGateway.getAltGatewayUrl() ?? tl` — confirma que o resume usa o host regional sempre que ele existir.
- `_handleClose(wasClean, code, reason)`: dispara quando o WebSocket bruto (`sock.webSocket`) fecha, marca `connectionState = WILL_RECONNECT` e chama `_connect()` sozinho (imediato ou com backoff). É o mecanismo nativo de reconexão, silencioso, sem reload de página.
- `close()` (o método público da classe) é outra coisa: é o caminho de desconexão manual (logout), marca `CLOSED` e não reconecta sozinho. Não serve para o que este spec precisa.

## Objetivo

Duas correções independentes, que juntas cobrem os dois cenários acima sem exigir ação do usuário em nenhum dos dois:

1. Rotear os hosts regionais de resume do gateway, corrigindo a causa raiz do cenário 1.
2. Quando a própria saída morre (cenário 2), forçar a reconexão nativa do Discord (silenciosa, sem reload) assim que uma saída nova estiver pronta, com fallback para o reload visível se o gancho não for encontrado, e sem teto fixo de tentativas.

## Não objetivos

- Não é objetivo deste spec mexer na técnica de escolha/validação de saída (isso é o trabalho de performance discutido separadamente).
- Não é objetivo eliminar o reload como mecanismo de segurança: ele continua existindo como fallback, só deixa de ser o caminho principal.
- Não é objetivo garantir reconexão silenciosa em 100% dos casos: se o Discord mudar o internal usado (`GatewayConnectionStore`/`getSocket`/`webSocket`) numa atualização futura, o plugin degrada para o reload visível de hoje, não quebra.

## Design

### 1. Rotear hosts regionais de resume do gateway

Em `streamFix/native.ts`, a lista `GATEWAY_HOSTS` e o `pacScript()` fazem comparação por igualdade exata de string. Trocar por um padrão que cobre os hosts regionais sem abrir mão de precisão:

```
/^(remote-auth-)?gateway(-[a-z0-9]+)*\.discord\.gg$/
```

Casa com `gateway.discord.gg`, `remote-auth-gateway.discord.gg` (os dois já cobertos hoje) e `gateway-us-east1-c.discord.gg` (o host regional observado). Não casa com `discord.gg` puro, que é o domínio de convites e não deve ser roteado.

O PAC script (`pacScript()`) passa a testar esse padrão em vez de percorrer uma lista fixa. `routedHosts()` deixa de devolver uma lista de strings estáticas e passa a devolver o padrão usado (para log e para o `installPac`/`resolveProxy` de verificação, que testa contra `GATEWAY_HOSTS[0]` — isso continua valendo, é só o primeiro elemento da lista canônica, não o padrão inteiro).

Nenhuma mudança de escopo em `LOGIN_HOSTS` (esses continuam por lista exata, já que login por `discord.com`/`canary.discord.com`/`ptb.discord.com` não tem variantes regionais conhecidas).

### 2. Reconexão silenciosa quando a saída morre

**Restrição confirmada no checkout local do Vencord** (`src/main/ipcPlugins.ts`, `src/preload.ts`): plugins de terceiros só ganham `ipcMain.handle()` automático por função exportada em `native.ts` — isto é, o renderer chama o processo principal (invoke), nunca o contrário. Os poucos canais de main→renderer que existem (`QUICK_CSS_UPDATE`, `THEME_UPDATE`) são cablados à mão dentro do próprio core do Vencord; um userplugin não pode abrir um canal novo desses sem editar o Vencord/Equicord em si, o que quebraria a premissa de o StreamFix ser só a pasta `streamFix/` copiada para dentro de qualquer checkout.

Isso descarta a ideia original de "o processo principal avisa o renderer assim que a saída está pronta" como um evento novo. Não é necessária, de qualquer forma: `retryWithProxy` já é uma chamada invoke que o processo principal segura aberta até `chooseExit()` terminar (`through === null` → `await chooseExit(excluded)` → só então resolve). O "esperar a saída nova ficar pronta" já acontece hoje, por trás de uma promise de invoke, sem precisar de push nenhum. A única mudança necessária é **o que a chamada faz quando resolve**: hoje sempre termina em `event.sender.reload()`; passa a tentar primeiro a reconexão silenciosa.

**Tudo continua dentro de `native.ts`**, sem tocar em `index.tsx`. `event.sender` (o `IpcMainInvokeEvent` que toda função exportada já recebe) expõe `executeJavaScript`, que roda código no mundo principal do renderer — com acesso aos globais do `Vencord.*`, o mesmo ambiente que o DevTools usou durante a investigação. Há precedente disso já em produção no próprio Vencord: `src/plugins/consoleShortcuts/native.ts:10` faz `e.sender.executeJavaScript("Vencord.Plugins.plugins.ConsoleShortcuts.eagerLoad(true)")` do processo principal.

Em `retryWithProxy`, no lugar de `event.sender.reload()`:

```js
const SILENT_RECONNECT_SCRIPT = `(function () {
    try {
        const store = Vencord.Webpack.findStore("GatewayConnectionStore");
        const sock = store && store.getSocket && store.getSocket();
        if (!sock || !sock.webSocket || typeof sock.webSocket.close !== "function") return false;

        sock.nextReconnectIsImmediate = true; // pula o backoff, reconecta na hora
        sock.webSocket.close();
        return true;
    } catch {
        return false;
    }
})()`;

async function reconnectSession(event: IpcMainInvokeEvent) {
    let silent = false;
    try {
        silent = await event.sender.executeJavaScript(SILENT_RECONNECT_SCRIPT);
    } catch {
        // executeJavaScript falhou (janela fechando, CSP, etc.) -- cai no reload abaixo
    }

    if (!silent) event.sender.reload();
}
```

Fechar o WebSocket bruto (não o método `close()` da classe, que é o caminho de desconexão manual e não reconecta sozinho) simula exatamente uma queda de rede: dispara o `onclose` que já está amarrado a `_handleClose`, o caminho de reconexão nativo do próprio Discord. `nextReconnectIsImmediate = true` evita esperar o backoff exponencial (que começa em ~1s e cresce). A call de voz não é afetada: ela roda num `RTCControlSocket` separado, confirmado observando os heartbeats desse socket continuarem inalterados durante toda a investigação.

**Fallback:** se o script devolver `false` (propriedade não encontrada, formato mudou numa atualização do Discord) ou se `executeJavaScript` falhar, cair no `event.sender.reload()` de hoje. O usuário nunca fica sem conserto automático, só perde a discrição dele se o internal quebrar.

### 3. Sem teto fixo de tentativas

Hoje `MAX_RETRIES = 2` é vitalício por abertura do Discord: depois de duas tentativas (sucedendo ou não), o plugin desiste de vez e pede reinício manual. Trocar por um orçamento que se renova: por exemplo, no máximo N tentativas dentro de uma janela deslizante de tempo (a definir no plano de implementação; um ponto de partida razoável é reiniciar o contador a cada intervalo sem falhas, não só em `sessionWorked()`).

Isso vale tanto para o caminho novo (reconexão silenciosa) quanto para o fallback (reload visível): nenhum dos dois deve desistir permanentemente numa sessão longa com internet instável.

## Fluxo depois da mudança

1. Internet do usuário oscila → Discord reconecta sozinho → agora sai pelo host certo (correção 1) → sessão continua liberada, sem nenhuma ação do plugin.
2. A saída (proxy/Tor) morre → `dropExit` já busca uma substituta → o próximo `CONNECTION_OPEN` (o próprio Discord tentando reconectar) dispara `retryBehindExit()` como já acontece hoje → a chamada invoke `retryWithProxy` espera `chooseExit()` terminar → quando a saída nova está pronta, o processo principal roda o script de reconexão silenciosa dentro do renderer via `executeJavaScript` → Discord reconecta sozinho (nativo, sem reload) → sessão liberada de novo.
3. Se o script não achar o internal (Discord mudou o formato): cai no `event.sender.reload()` de hoje, sem teto vitalício de tentativas.

## Riscos

- **Dependência de internal não documentado** (`GatewayConnectionStore.getSocket().webSocket`). Mitigado pelo fallback ao reload: uma mudança do lado do Discord degrada a experiência, não quebra a recuperação.
- **`executeJavaScript` pode falhar** (janela fechando, mudança de CSP do Discord). Capturado explicitamente e tratado como "sem reconexão silenciosa", caindo no reload.
- **Padrão de host regex pode ficar amplo ou estreito demais** se o Discord mudar a convenção de nomes de host regional. Testar contra o valor observado (`gateway-us-east1-c.discord.gg`) e revisar se um relato futuro mostrar um formato diferente.

## Testes

O repositório do plugin (`streamFix/`) não tem suíte automatizada hoje (diferente do `installer/`, que já ganhou testes de caracterização). Verificação manual, com Discord real:

- Forçar queda de internet (desligar Wi-Fi alguns segundos) com Go Live ativo e confirmar que a sessão continua liberada sem Ctrl+R.
- Forçar a saída a morrer (derrubar o Tor local, ou apontar `proxy` para um endereço morto) em sessão já liberada, e confirmar que o plugin reconecta sozinho, sem reload visível da janela.
- Simular o internal ausente (comentar temporariamente o `getSocket` do mock, ou testar numa versão de Discord onde o nome mudou) e confirmar que cai no reload visível em vez de travar.
