# Changelog

## [2.4.4](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.4.3...v2.4.4) (2026-09-21)


### Bug Fixes

* o asset do Equilotl nao tem "darwin" no nome, e o 404 era silencioso ([a47fa9b](https://github.com/EduardoVasconceloss/StreamFix/commit/a47fa9b563433e5ff4bae8378807c7b1efd88316))

## [2.4.3](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.4.2...v2.4.3) (2026-09-21)


### Bug Fixes

* o ping do macOS e BSD, e o instalador escondia o motivo da falha ([71fe716](https://github.com/EduardoVasconceloss/StreamFix/commit/71fe716ba9bcec5022060084389fbaf5b3b67fa9))

## [2.4.2](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.4.1...v2.4.2) (2026-09-21)


### Bug Fixes

* o provisionador nao era montado inteiro, e o Windows quebrou junto ([1981a35](https://github.com/EduardoVasconceloss/StreamFix/commit/1981a3555ef095bfe8e8ce3c00a871b4cbea9255))
* o teste de desinstalacao derrubava o CI no Linux ([d83ccb1](https://github.com/EduardoVasconceloss/StreamFix/commit/d83ccb1eff9269edc020fac67cf935d3e07e6e00))

## [2.4.1](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.4.0...v2.4.1) (2026-09-20)


### Bug Fixes

* a captura penduraria o script, e o -i any nao existe no macOS ([d984404](https://github.com/EduardoVasconceloss/StreamFix/commit/d98440434f7958b8117a561f3ac94c6d91d28312))
* a linha da versao saia com a quebra literal no meio ([37aad06](https://github.com/EduardoVasconceloss/StreamFix/commit/37aad0617b77ff8f03cf17e38be4a43be9e69691))
* o lsof da medicao combinava os filtros com OU, nao com E ([ba0b53b](https://github.com/EduardoVasconceloss/StreamFix/commit/ba0b53b6b9b3d5477c9ad8c84d82fc0dc6343375))
* o wg responde em duas colunas por interface, nao tres ([25db5e1](https://github.com/EduardoVasconceloss/StreamFix/commit/25db5e1b3e0afaa9e4f23877daad09c368602d34))
* o wg-quick exige bash 4+, e o macOS traz o 3.2 ([70e0ae9](https://github.com/EduardoVasconceloss/StreamFix/commit/70e0ae90a0167e6c593d7a59c23e4178b8f41416))

## [2.4.0](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.3.1...v2.4.0) (2026-09-20)


### Features

* desinstalar o StreamFix pela janela e pelo terminal, e consertar o winget ([b0ddd75](https://github.com/EduardoVasconceloss/StreamFix/commit/b0ddd75af55c6599a038a3c4d8259febd37e2680))
* o controle do tunel para macOS, por wg-quick ([3d9499b](https://github.com/EduardoVasconceloss/StreamFix/commit/3d9499bf73445353f803ddb3261f13be141056df))
* o instalador de shell monta o tunel no macOS ([e74315b](https://github.com/EduardoVasconceloss/StreamFix/commit/e74315be9427f141aad7da3907da074819f1692b))
* o perfil do macOS sai sem AllowedApps e com nome de controle curto ([f007e8f](https://github.com/EduardoVasconceloss/StreamFix/commit/f007e8fa87298989a3a52b922a6420ab33b13a97))

## [2.3.1](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.3.0...v2.3.1) (2026-09-12)


### Bug Fixes

* depois de reiniciar o PC, o Go Live so voltava reinstalando ([9c29419](https://github.com/EduardoVasconceloss/StreamFix/commit/9c294193c5e89d2af753341ef20eb7436b57d2ed))

## [2.3.0](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.2.0...v2.3.0) (2026-09-12)


### Features

* tunel em dois niveis, com a call a 35 ms em vez de 130 ([cdf1697](https://github.com/EduardoVasconceloss/StreamFix/commit/cdf1697b80de09f12453d76b6cfde6802300835b))


### Bug Fixes

* erro do servico do WireSock virava caixa sobre "EndInvoke" ([38dd080](https://github.com/EduardoVasconceloss/StreamFix/commit/38dd080f225c7f4355b5cf0d0e74a22062e418cb))

## [2.2.0](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.1.1...v2.2.0) (2026-09-11)


### Features

* dizer quando o .NET da maquina e que esta quebrado ([817f57f](https://github.com/EduardoVasconceloss/StreamFix/commit/817f57f1784e4dc0bcf74e7e2bcc1fe49e0edf2e))

## [2.1.1](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.1.0...v2.1.1) (2026-09-11)


### Bug Fixes

* o tunel carregava a faixa interna em vez de rota ([accc5cc](https://github.com/EduardoVasconceloss/StreamFix/commit/accc5ccef48c1a0c0bec7577062e487d5ec70b15))
* publicar o que a documentacao manda rodar ([b73b29e](https://github.com/EduardoVasconceloss/StreamFix/commit/b73b29e747fe8c4a1a881d21ed08c7f9c8532ebc))

## [2.1.0](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.0.1...v2.1.0) (2026-09-11)


### Features

* diagnostico do tunel, para quando "conectado" nao basta ([8d41ae7](https://github.com/EduardoVasconceloss/StreamFix/commit/8d41ae7822825d281728d250b295a16125f08236))


### Bug Fixes

* a janela exigia convite de quem ja tem o tunel ([042d77e](https://github.com/EduardoVasconceloss/StreamFix/commit/042d77e49102542b0e41e53355cab8b6f2a6325a))
* o tunel precisa estar de pe ANTES de o Discord abrir ([fbcf56f](https://github.com/EduardoVasconceloss/StreamFix/commit/fbcf56f3d252020ed4f91a8451bf94ce0f1c4fcd))
* o tunel so aceitava o Discord estavel ([ed76028](https://github.com/EduardoVasconceloss/StreamFix/commit/ed76028a83fe68b37673fab9f5f840c6f8283667))
* tunel ja de pe nao e falha de conexao ([06f214e](https://github.com/EduardoVasconceloss/StreamFix/commit/06f214ed6e02c32f4d6b3493c7b25136348b86d3))

## [2.0.1](https://github.com/EduardoVasconceloss/StreamFix/compare/v2.0.0...v2.0.1) (2026-09-11)


### Bug Fixes

* o provisionamento estourava no PowerShell 5.1 ([ba85116](https://github.com/EduardoVasconceloss/StreamFix/commit/ba8511686cc2fa5d915dadb717a752609a87a3dc))

## [2.0.0](https://github.com/EduardoVasconceloss/StreamFix/compare/v1.2.2...v2.0.0) (2026-09-11)


### ⚠ BREAKING CHANGES

* remove a proxy de gateway

### Features

* assistir -- aborta a entrada, sobe o tunel, e entra de novo ([2a708b6](https://github.com/EduardoVasconceloss/StreamFix/commit/2a708b6be1746e2885b75dc98a94665ddf40b3fa))
* coletor -- a traducao entre o Discord e o SessionMonitor ([b072cd4](https://github.com/EduardoVasconceloss/StreamFix/commit/b072cd4667da4b32e3afbae2a249e6c8d56d31a7))
* controle -- sobe o tunel e confere que ele subiu so para o Discord ([31bf533](https://github.com/EduardoVasconceloss/StreamFix/commit/31bf533a88379f289c68add3ba77acdc9f90c642))
* entrega -- o teste negativo virou ferramenta, e a saida ganhou operacao ([b5961a4](https://github.com/EduardoVasconceloss/StreamFix/commit/b5961a4eaa4ceefdb349b8f5288b384d54576772))
* instalador -- monta o tunel antes de ligar o plugin ([143ec2f](https://github.com/EduardoVasconceloss/StreamFix/commit/143ec2fc66700b64403c50d7c3f40aacd8388a70))
* perfil -- gera o .conf do WireSock e mede o MTU em vez de chutar ([2a032c4](https://github.com/EduardoVasconceloss/StreamFix/commit/2a032c422990dfb9fe03579c5d732becff470eb3))
* porteiro -- bloqueia o Go Live condenado, com o motivo na tela ([d27c724](https://github.com/EduardoVasconceloss/StreamFix/commit/d27c724d95bc6d39a3c3f2f63a979d4e3244250e))
* provisionamento -- convite vira peer, e a privada nunca sai da maquina ([187eff8](https://github.com/EduardoVasconceloss/StreamFix/commit/187eff8a3a819198bb7c0a38ed6ab92f5d6e5826))
* remove a proxy de gateway ([fc6e663](https://github.com/EduardoVasconceloss/StreamFix/commit/fc6e663b2584f4a03a4d767700ff25fcaac80e49))
* **streamfix:** decide se a entrega de video morreu ([914b923](https://github.com/EduardoVasconceloss/StreamFix/commit/914b923cecd5dc05a7c0eb2face18d1a341cbc04))
* **streamfix:** roteia controle TCP de midia, desligado por padrao ([1a50c31](https://github.com/EduardoVasconceloss/StreamFix/commit/1a50c310c3343ed214d14b4a89eb140dc8603c50))


### Bug Fixes

* impede duas capturas gravando a mesma fixture ([e3bb1dd](https://github.com/EduardoVasconceloss/StreamFix/commit/e3bb1dd826e5cd976b77a6b2d06cc050a0eae976))
* instalar de novo nao provisiona de novo ([ea24cc7](https://github.com/EduardoVasconceloss/StreamFix/commit/ea24cc7162ffa2e17904912008e03ac06a7003d1))
* monitor nao declara quebra quando o espectador sai ([33e5f07](https://github.com/EduardoVasconceloss/StreamFix/commit/33e5f079a85a17645c628bb1f6be70fc100d8e74))
* o porteiro confiava numa leitura que envelhece ([21efc22](https://github.com/EduardoVasconceloss/StreamFix/commit/21efc2250d1788288a1a4283e34c5edd953abb4d))
* **streamfix:** aceita a saida Tor, que era descartada com ela no ar ([346addd](https://github.com/EduardoVasconceloss/StreamFix/commit/346addd2199f36066b3f491278aecb67e69316af))

## [1.2.2](https://github.com/EduardoVasconceloss/StreamFix/compare/v1.2.1...v1.2.2) (2026-08-21)


### Bug Fixes

* **streamfix:** rotear hosts regionais do gateway e reconectar sozinho quando a saida morre ([1d73b6d](https://github.com/EduardoVasconceloss/StreamFix/commit/1d73b6db6f3428c493a33064efc6d63a2ea83bd6))
* **streamfix:** rotear hosts regionais do gateway e reconectar sozinho quando a saida morre ([6f3d42b](https://github.com/EduardoVasconceloss/StreamFix/commit/6f3d42b9a4e205fc1c69a69bda9384192a828043))

## [1.2.1](https://github.com/EduardoVasconceloss/StreamFix/compare/v1.2.0...v1.2.1) (2026-08-21)


### Bug Fixes

* detectar Node antigo no PATH e usar instalacao mais nova sem exigir desinstalar ([5c05824](https://github.com/EduardoVasconceloss/StreamFix/commit/5c05824ef67e3480c330b45d945d767f22a15419))
* instalador detecta Node antigo no PATH e usa versao compativel ([e282b4f](https://github.com/EduardoVasconceloss/StreamFix/commit/e282b4fab4ce55cf649bc7815785329f736ff4bd))

## [1.2.0](https://github.com/EduardoVasconceloss/StreamFix/compare/v1.1.1...v1.2.0) (2026-08-20)


### Miscellaneous Chores

* forçar release 1.2.0 com o suporte a macOS ([884debf](https://github.com/EduardoVasconceloss/StreamFix/commit/884debfe74f7bb6a7660b72d173b0cb1c8356bb1))

## [1.1.1](https://github.com/EduardoVasconceloss/StreamFix/compare/v1.1.0...v1.1.1) (2026-08-20)


### Bug Fixes

* **instalador:** fazer o --location chegar ao Equilotl, e nao pendurar no sudo ([fb7bc96](https://github.com/EduardoVasconceloss/StreamFix/commit/fb7bc9693ec78d4146bcb21685321fb6794d6a67))

## [1.1.0](https://github.com/EduardoVasconceloss/StreamFix/compare/v1.0.2...v1.1.0) (2026-08-20)


### Features

* **instalador:** achar o Discord moderno e suportar flatpak no Linux ([270cbfc](https://github.com/EduardoVasconceloss/StreamFix/commit/270cbfc05dce96c1913f5fd5dd67be6f73456359))


### Bug Fixes

* gravar as settings na chave StreamFix, nao na antiga ([14bc8dc](https://github.com/EduardoVasconceloss/StreamFix/commit/14bc8dc2bc7e326fe82718c56827d37b7a162602))
* normalizar e validar a pasta de instalacao em vez de recusar array ([52e81c3](https://github.com/EduardoVasconceloss/StreamFix/commit/52e81c3d68a2354e61494d61a2b68e2c7b036d74))
* publicar os scripts na release, nao so os .exe do Windows ([3411628](https://github.com/EduardoVasconceloss/StreamFix/commit/3411628f93865999746f212cedf832768256d1a5))

## [1.0.2](https://github.com/EduardoVasconceloss/StreamFix/compare/v1.0.1...v1.0.2) (2026-08-20)


### Bug Fixes

* anexar o SHA256SUMS.txt na release ([42430b9](https://github.com/EduardoVasconceloss/StreamFix/commit/42430b9531558ff84fe7f650537a1cf8c9873da1))
* nao deixar a saida de comando nativo virar valor de retorno ([11767b6](https://github.com/EduardoVasconceloss/StreamFix/commit/11767b624c978fe3eaf5e89fbf3951f3cce15be6))

## [1.0.1](https://github.com/EduardoVasconceloss/StreamFix/compare/v1.0.0...v1.0.1) (2026-08-20)


### Bug Fixes

* destravar o versionamento das releases e dos .exe ([cea56f9](https://github.com/EduardoVasconceloss/StreamFix/commit/cea56f97abbabebf828c7009a16cc3d7c3fdf70e))
* verificar o git tambem quando o checkout ja existe ([b6fec20](https://github.com/EduardoVasconceloss/StreamFix/commit/b6fec200b3e7e0ad5fdfb736e14fba7293004803))

## 1.0.0 (2026-08-19)


### Features

* adotar release-please e resolver pin do instalador via API do GitHub ([68f370a](https://github.com/EduardoVasconceloss/StreamFix/commit/68f370aed94e6fcf4be21c20afd415f2c4e598ba))


### Bug Fixes

* fazer release-please disparar o build do instalador na mesma run ([c5a312a](https://github.com/EduardoVasconceloss/StreamFix/commit/c5a312ae57dca862b83af67a3644957ccfa58700))
