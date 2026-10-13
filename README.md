# DevBots

Extension VS Code qui transforme le process `.work` en un flux guidé, de l'import
des tickets jusqu'au merge. Les skills, les gabarits et le dossier `.work`
restent la source de vérité : l'extension est une surcouche, et le mode manuel
reste disponible à tout moment.

Spécification complète : [Proposition — Extension VS Code Dev Flow](https://claude.ai/code/artifact/854a7c67-afdc-4529-97c0-bc15dd5ec304).

## État

Phase 1 (fondations) en cours. Ce qui marche aujourd'hui :

- paramètres par dépôt, secrets dans le SecretStorage ;
- connecteur GitHub : une issue parente et ses sub-issues deviennent des fiches ;
- côté GitHub, choix des issues dans la liste des issues ouvertes du dépôt ;
- connecteur Azure DevOps : un epic ou une feature et ses user stories ;
- import vers `.work/new`, avec marquage « à revoir » au lieu d'un écrasement ;
- panneau latéral en lecture (New, Ready, Done) ;
- vérification du CLI Claude Code au démarrage.

Les phases suivantes (planification, agents de dev, review et merge) sont
décrites dans la proposition.

## Démarrer

```bash
npm install
npm run check   # typecheck + lint + tests
npm run watch   # puis F5 dans VS Code pour lancer l'extension
```

`F5` ouvre une fenêtre VS Code avec l'extension chargée. Ouvre-y un dépôt qui
contient (ou contiendra) un dossier `.work`.

## Configuration

| Paramètre | Rôle |
| --- | --- |
| `devbots.source.kind` | `github` ou `azureDevOps`, par dépôt |
| `devbots.github.repository` | `owner/repo` ; vide, il est déduit du remote `origin` |
| `devbots.azureDevOps.orgUrl` | `https://dev.azure.com/<org>` ou l'URL d'un Azure DevOps Server |
| `devbots.azureDevOps.project` | Nom du projet |
| `devbots.workDir` | Dossier du flux, `.work` par défaut |
| `devbots.import.githubTrustedAuthorsOnly` | N'importe que tes issues et celles portant le label de confiance |
| `devbots.agents.maxParallel` | Plafond d'agents de dev simultanés (phase 3) |
| `devbots.claude.executable` | Commande du CLI Claude Code |

### Accès aux sources

L'extension ne lit que les tickets, et n'écrit jamais rien dans la source.

- **GitHub** : la connexion GitHub intégrée à VS Code suffit. Pour un jeton
  dédié, lance « DevBots : enregistrer un jeton d'accès » avec un token à
  granularité fine limité à la lecture des issues.
- **Azure DevOps** : un PAT limité à la lecture des work items, enregistré par
  la même commande.

Les jetons vivent dans le SecretStorage de VS Code, jamais dans les paramètres
ni dans `.work`.

## Commandes

| Commande | Effet |
| --- | --- |
| DevBots : importer des tickets | GitHub : liste à cocher des issues ouvertes (le crayon garde la saisie d'un numéro). Azure DevOps : demande un ID. Remplit `.work/new` |
| DevBots : rafraîchir le flux | Relit `.work` |
| DevBots : enregistrer un jeton d'accès | Stocke un jeton dans le SecretStorage |
| DevBots : effacer le jeton d'accès | Le retire |
| DevBots : vérifier l'installation de Claude Code | Teste le CLI et sa version |

## Documentation

- [Architecture](docs/architecture.md) — les modules et leurs frontières
- [Format des fiches](docs/format-fiches.md) — frontmatter et resynchronisation
