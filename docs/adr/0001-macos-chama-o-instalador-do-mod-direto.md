---
status: accepted
---

# No macOS o instalador do StreamFix chama o instalador do mod direto, sem passar pelo `pnpm inject`

No Linux e no Windows o instalador do StreamFix injeta rodando `pnpm inject` dentro do checkout, deixando o wrapper de injeção baixar e executar o instalador do mod. No macOS isso não funciona: o wrapper baixa o build **GUI** do Equilotl (`Equilotl-darwin-<arch>.zip`), e o `cli.go`, onde moram `--install` e `--location`, é `//go:build cli`. O `main` do build GUI não lê `os.Args`, então as flags são silenciosamente ignoradas e uma janela abre. Como o instalador do StreamFix promete achar tudo sozinho e tem um modo `--yes` sem ninguém para clicar, no macOS ele baixa o `EquilotlCli-darwin-<arch>` da mesma release e o executa por conta própria.

## Considered Options

- **Deixar a janela abrir e guiar o clique.** Mata o `--yes` no macOS e quebra a promessa de instalação automática. Continua sendo o caminho do Vencord, que não publica CLI para darwin, mas não serve como padrão.
- **Fazer a injeção nós mesmos**, renomeando o `app.asar` e escrevendo o stub. Rejeitada por contrariar uma promessa pública do README ("Ele nunca mexe no `app.asar`: quem injeta é o instalador oficial do Equicord/Vencord"), que vale mais que a conveniência de implementação.

## Consequences

- A chamada precisa reproduzir o que o wrapper faz por baixo: `--install --location <caminho do .app>` mais `EQUICORD_USER_DATA_DIR`, `EQUICORD_DIRECTORY=<checkout>/dist/desktop` e `EQUICORD_DEV_INSTALL=1`. Se esse contrato mudar do lado do Equicord, o macOS quebra sem que o Linux ou o Windows sintam.
- Passamos a depender do nome do asset (`EquilotlCli-darwin-arm64` e `-x64`). Um rename do lado deles derruba o download, e por isso a falha cai no caminho GUI em vez de abortar.
- A barra de confiança não muda: a URL é a mesma `releases/latest/download/` que o wrapper já usa hoje, do mesmo publicador, e o Equilotl não publica checksums para nenhum dos seus binários.
- O Vencord no macOS fica sem caminho headless enquanto não houver um `VencordInstallerCli-darwin`. Por isso o modo temporário não é oferecido nessa combinação: ele prometeria desfazer a injeção sozinho e depois abriria uma janela pedindo clique.
