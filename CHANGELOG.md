# Changelog

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
