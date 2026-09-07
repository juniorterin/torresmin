# Changelog

Mudanças relevantes deste projeto. Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado

- **Metadados dos catálogos no banco** (`metaStore.js`, `scripts/buildMetaStore.js`). Servir um catálogo não depende mais do Cinemeta em tempo de request — antes, cada `504` esporádico dele derrubava um filme da home. Título, sinopse e gêneros vêm em **pt-BR** via TMDB.
- **Auditoria de catálogos contra o IMDb** (`scripts/verifyCatalogs.js`), com execução semanal no CI que abre issue ao encontrar id incorreto.
- **Validação estrutural dos catálogos nos testes** — formato de id, duplicatas e consistência entre `CATALOGS` e os arquivos semente.
- **`seedCatalogs.js --replace` e `--rebuild`** — o seed só sabia acrescentar, o que o tornava inútil justamente depois de uma rodada de correções. O `--rebuild` faz o store espelhar os arquivos, com backup automático.
- **Disjuntor por indexador** — indexador com download quebrado passa a ser ignorado por 10 minutos em vez de bloquear cada busca até o timeout.
- Controle de **tempo máximo de busca** na interface, e sugestões de nome ao instalar o addon.
- `LICENSE` (MIT), `CONTRIBUTING.md` e templates de issue.

### Corrigido

- **~2 000 ids do IMDb apontavam para o filme errado** (46% das entradas). Não eram ids inválidos: eram ids válidos de *outras* obras, então o catálogo carregava normalmente exibindo o filme errado. "Ordet" levava a um curta do Pernalonga; "Ivan's Childhood", a um peplum italiano.
- **Catálogos apareciam vazios e continuavam assim por horas.** A montagem disparava uma requisição por item sem limite — com 69 catálogos, o pico passava de mil conexões paralelas ao Cinemeta, que respondia com timeout. O resultado vazio era então cacheado por 6 horas. Medido: 45 dos 69 catálogos vazios em cache.
- **Filmes que não pertenciam ao catálogo**: 83 removidos, entre eles doze filmes do Polanski rodados fora da Polônia em "cinema polonês" e sete do Takashi Miike (1996-2003) na Nouvelle Vague japonesa, um movimento dos anos 1950-70.
- **Prêmios inventados**: o catálogo do Leão de Ouro listava 11 "vencedores" entre 1969 e 1979, período em que Veneza não concedeu o prêmio.
- **Busca ~9x mais rápida** (27,5s → 2,9s). O gargalo não era a busca: dois indexadores devolviam resultados cujo `.torrent` nunca baixava, e cada um ocupava a fila até estourar o timeout.
- Indexador desabilitado no Prowlarr passa a ser respeitado — antes o addon consultava todos os cadastrados, ignorando o campo `enable`.
- Seleção de catálogos na tela de configuração não indicava o que estava selecionado (classe CSS divergente entre o JS e o CSS).
- Crash do processo por evento `error` não tratado ao repassar o stream do TorrServer.
- Busca por "The X-Files" retornava "Diabolical: The Epstein Files" — tokens de uma letra eram descartados na comparação de títulos.

### Alterado

- Interface separa o conteúdo do **cliente final** do de **desenvolvedor**, e a chamada diz o que o produto é: um addon de Stremio que transmite torrents baixados no seu próprio servidor.
- Texto deixou de prometer que "não existe espera". O início depende dos seeds do release, e a página agora explica isso e orienta a preferir resultados com mais seeders.
- READMEs reescritos, em português e inglês.
