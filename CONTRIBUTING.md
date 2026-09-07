# Contribuindo com o TorrESMIN

Obrigado pelo interesse! Este guia cobre o que você precisa saber antes de abrir um PR.

## Rodando o projeto

O jeito como este projeto é desenvolvido é com a stack Docker local — não `npm start`. O addon só é realmente útil ligado a um Prowlarr e a um TorrServer de verdade:

```bash
cp .env.example .env        # preencha JACKETT_API_KEY e ADDON_PUBLIC_URL
docker compose -f docker-compose.local.yaml up -d
```

Salvar um `.js` já recarrega — o nodemon dentro do container reinicia em segundos. Detalhes e as armadilhas em [`.claude/docs/dev-workflow.md`](.claude/docs/dev-workflow.md).

Rebuild só é necessário ao mexer no `package.json`:

```bash
docker compose -f docker-compose.local.yaml up -d --build torresmin
```

## Testes

```bash
npm test                  # tudo
npm run test:coverage     # com cobertura
```

Usamos o runner nativo do Node (`node:test`), sem framework extra — o projeto tem poucas dependências de propósito, e o Node 22 já traz o necessário.

Duas coisas que economizam tempo:

- **Todo arquivo de teste começa com `require("../helpers/testEnv")`**, e precisa ser a primeira linha. O `.env` real tem credenciais de verdade, e o `dotenv` nunca sobrescreve variável já definida — se a ordem estiver errada, o teste pode pegar a configuração real em vez da neutra.
- **`test/integration/adminApi.route.test.js` falha em ~1 de 3 execuções** sob `node --test`, com `Unable to deserialize cloned data`. É um bug de IPC do runner, não do código: rodando direto com `node test/integration/adminApi.route.test.js` passa sempre. Se a CI acusar essa falha, rode de novo antes de investigar.

Contexto completo em [`.claude/docs/testing.md`](.claude/docs/testing.md).

## Antes de abrir o PR

- `npm test` passando.
- Leia o guia da área que você tocou. A pasta [`.claude/docs/`](.claude/docs) tem um documento por subsistema, escrito para explicar **por que** as coisas são como são — não só o que fazem. O de [gotchas](.claude/docs/gotchas.md) lista armadilhas conhecidas que já custaram tempo a alguém.
- Não há lint configurado (o `eslint` é dependência, mas não há config nem script). Siga o estilo do arquivo que estiver editando.

## Mexendo nos catálogos

Se for adicionar ou corrigir catálogos curados, leia [`.claude/docs/catalogs-and-rss.md`](.claude/docs/catalogs-and-rss.md) — em especial a seção sobre integridade de dados. Resumo do que importa:

**Todo `imdbId` precisa ser verificado.** Um id errado não quebra nada visivelmente: ele é um id *válido de outro filme*, então o catálogo carrega normalmente exibindo a obra errada. Quase metade das entradas já esteve assim.

```bash
node scripts/verifyCatalogs.js meu_catalogo    # confere id contra o IMDb
npm test                                       # valida estrutura, roda em ms
```

**Arquivo semente não é o catálogo em produção.** `scripts/seed-data/*.json` alimenta o `seedCatalogs.js`; o que o app serve é o store. Para o store espelhar os arquivos:

```bash
node scripts/seedCatalogs.js --rebuild    # apaga e recria, com backup automático
node scripts/buildMetaStore.js            # busca os metadados dos ids novos
```

## Escopo do projeto

O recorte é estreito de propósito: **Prowlarr/Jackett para buscar, TorrServer para transmitir.** Não há suporte a Real-Debrid, TorBox, StremThru nem P2P puro, e PRs adicionando esses provedores provavelmente não serão aceitos — a simplicidade é a escolha, não uma lacuna.

## Reportando bugs

Abra uma issue com o log do container (`docker logs <container>`), o que você esperava e o que aconteceu. Se for problema de reprodução, diga também o aparelho (TV, celular, iOS) e o formato do stream — boa parte dos travamentos relatados acaba sendo codec que o aparelho não decodifica, não falha do addon.
