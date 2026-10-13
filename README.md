# DevBots

Extension VS Code qui transforme le process `.work` en un flux guidé, de l'import
des tickets jusqu'au merge. Les skills, les gabarits et le dossier `.work`
restent la source de vérité : l'extension est une surcouche, et le mode manuel
reste disponible à tout moment.

Spécification complète : [Proposition — Extension VS Code Dev Flow](https://claude.ai/code/artifact/854a7c67-afdc-4529-97c0-bc15dd5ec304).

## État

Phases 1 (fondations), 2 (planification), 3 (dev et supervision) et 4 (review
et merge) livrées.
Ce qui marche aujourd'hui :

- paramètres par dépôt, secrets dans le SecretStorage ;
- connecteur GitHub : une issue parente et ses sub-issues deviennent des fiches ;
- choix dans une liste à cocher : issues GitHub ouvertes, ou epics, features et
  stories Azure DevOps ouverts, sans ceux que `.work` connaît déjà ;
- connecteur Azure DevOps : un epic, une feature ou une story, et sa descendance ;
- les tickets qui regroupent des stories deviennent des fiches de
  `.work/features` ;
- import vers `.work/new`, avec marquage « à revoir » au lieu d'un écrasement ;
- saisie à la main de features (`LOCAL-F<n>`) et de stories (`LOCAL-<n>`),
  en fiches pré-remplies à compléter dans l'éditeur ;
- suppression d'une story ou d'une feature depuis le panneau (corbeille) ;
- panneau latéral (New, Ready, Done), les stories de New rangées sous leur feature ;
- vérification du CLI Claude Code au démarrage ;
- atelier de planification : compréhension et questions, plan structuré revu
  section par section, versions et diff, validation qui place la fiche dans
  `ready/` (voir [Planification](docs/planification.md)) ;
- gabarits du plan et du CR remplaçables par ceux du dépôt, dans
  `.work/templates/` (voir [Gabarits](docs/gabarits.md)) ;
- dev d'un clic depuis Ready : file d'attente plafonnée, dépendances
  vérifiées d'après les plans, pas de parallélisme sur des fichiers communs ;
- branche de feature, branche de story et worktree préparés par l'extension,
  dépendances installées ;
- agent de dev borné à une liste de commandes, journal en direct, commit par
  l'extension ;
- revue du CR, étapes de supervision du dépôt (`.work/supervision.json`,
  pre-pr-check par défaut), tri des problèmes en fiches `LOCAL-<n>`, boucle de
  correction plafonnée, jusqu'à « À valider » (voir
  [Dev et supervision](docs/dev-et-supervision.md)) ;
- `.work/state.json`, barre d'état des agents, notifications, reprise après
  un redémarrage ;
- carte « À valider » : diff natif fichier par fichier, worktree dans une
  nouvelle fenêtre ou l'espace de travail, application sur un port propre au
  worktree, retours renvoyés à l'agent dans sa session ;
- feu vert : merge séquentiel dans la branche de la feature, intégration de la
  feature si elle a avancé, checks, conflit renvoyé à l'agent, suppression du
  worktree et de la branche, fiche dans Done (voir
  [Review et merge](docs/review-et-merge.md)).

La phase suivante (finitions : resynchronisation, paquet `.vsix`, doc
d'équipe) est décrite dans la proposition.

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
| `devbots.planning.skill` | Skill de planification du dépôt (par exemple `plan-story`) ; vide : consigne générique |
| `devbots.planning.template` | Gabarit de plan de story, relatif au dépôt ; vide : `.work/templates/plan.md`, sinon le gabarit par défaut |
| `devbots.planning.model` | Modèle de l'atelier, `opus` par défaut |
| `devbots.planning.maxResumes` | Plafond de reprises d'une session de planification |
| `devbots.agents.maxParallel` | Plafond de stories traitées en même temps |
| `devbots.dev.skill` | Skill de dev du dépôt (par exemple `dev-story`) ; vide : consigne générique |
| `devbots.dev.model` | Modèle proposé au lancement ; vide : celui que recommande le plan |
| `devbots.dev.allowedCommands` | Commandes que l'agent de dev peut lancer, par préfixe |
| `devbots.dev.installCommand` | Installation des dépendances d'un worktree ; vide : détectée, `none` : aucune |
| `devbots.dev.rulesFile` | Règles de dev données à l'agent ; vide : le `CLAUDE.md` suffit |
| `devbots.git.baseBranch` | Départ des branches de feature ; vide : la branche courante |
| `devbots.worktrees.root` | Dossier des worktrees ; vide : `<dépôt>.worktrees` |
| `devbots.supervision.model` | Modèle de la revue du CR et des étapes, `opus` par défaut |
| `devbots.supervision.maxLoops` | Plafond de boucles de correction, sauf `maxLoops` de `supervision.json` |
| `devbots.merge.checkCommands` | Commandes relancées au merge quand la feature a avancé ; vide : aucune |
| `devbots.review.serveCommand` | Lance l'application d'un worktree en revue, `{port}` compris |
| `devbots.review.basePort` | Premier port des worktrees en revue, 4201 par défaut |
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
| DevBots : importer des tickets | GitHub : liste à cocher des issues ouvertes (le crayon garde la saisie d'un numéro). Azure DevOps : liste à cocher des epics, features et stories ouverts. Les tickets déjà importés n'y figurent plus, un parent non plus quand toutes ses stories le sont ; le crayon les relit. Remplit `.work/new` |
| DevBots : nouvelle story | Demande la feature (ou en crée une) et le titre, écrit une fiche `LOCAL-<n>` dans `.work/new` et l'ouvre (aussi : le `+` du panneau, de New ou d'une feature) |
| DevBots : nouvelle feature | Écrit une fiche `LOCAL-F<n>` dans `.work/features` et l'ouvre |
| DevBots : planifier la story | Ouvre l'atelier d'une story de New (aussi : l'ampoule sur la story) |
| DevBots : supprimer la fiche | Clic droit sur une story ou une feature du panneau : la fiche part à la corbeille, après confirmation. Un ticket importé redevient proposé à l'import |
| DevBots : rafraîchir le flux | Relit `.work` |
| DevBots : enregistrer un jeton d'accès | Stocke un jeton dans le SecretStorage |
| DevBots : effacer le jeton d'accès | Le retire |
| DevBots : vérifier l'installation de Claude Code | Teste le CLI et sa version |
| DevBots : personnaliser les gabarits | Dépose les gabarits par défaut du plan et du CR dans `.work/templates/`, sans écraser ceux qui existent, et les ouvre |
| DevBots : lancer le dev | Met une story de Ready en file, avec le modèle choisi (aussi : ▶ sur la story) |
| DevBots : arrêter l'agent | Interrompt l'agent ; la story passe bloquée |
| DevBots : relancer la story | Remet en file une story bloquée ; l'agent reprend sa session |
| DevBots : retirer du flux de dev | Rend à Ready une story en file, bloquée ou à valider ; worktree et branche restent |
| DevBots : journal de l'agent | Le journal de la story, en direct |
| DevBots : compte rendu de dev | Le CR de la story |
| DevBots : rapport de supervision | Revue du CR, problèmes de chaque étape, fiches créées par le tri |
| DevBots : trancher une dépendance | Attendre une dépendance infirmée par le plan, ou lever une dépendance confirmée |
| DevBots : reclasser la fiche | Fiche née du tri : de New à Ready, ou l'inverse |
| DevBots : personnaliser la supervision | Dépose `.work/supervision.json` prérempli et l'ouvre |
| DevBots : voir le diff | Story à valider, bloquée ou mergée : ses changements dans la vue diff native |
| DevBots : ouvrir le worktree | Dans une nouvelle fenêtre, ou ajouté à l'espace de travail |
| DevBots : lancer l'application | `devbots.review.serveCommand` dans un terminal, sur le port du worktree |
| DevBots : renvoyer des retours à l'agent | Tes remarques repartent dans sa session ; la story repasse par la revue |
| DevBots : feu vert (merge) | Merge dans la branche de la feature, nettoyage, fiche dans Done |

## Documentation

- [Architecture](docs/architecture.md) — les modules et leurs frontières
- [Format des fiches](docs/format-fiches.md) — frontmatter, fiches locales et resynchronisation
- [Planification](docs/planification.md) — l'atelier, le gabarit et `.work/plans`
- [Gabarits](docs/gabarits.md) — plan et CR, ceux du dépôt ou ceux par défaut
- [Dev et supervision](docs/dev-et-supervision.md) — file d'attente, worktrees, agents, revue, tri
- [Review et merge](docs/review-et-merge.md) — la carte « À valider », retours, feu vert, merge
