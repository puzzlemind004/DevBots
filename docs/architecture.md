# Architecture

Le principe directeur : **le déterministe dans le code, le jugement dans Claude**.
L'état, l'ordre des tâches, la parallélisation, les worktrees et les merges sont
tenus par l'extension. Claude analyse, planifie, code et relit.

## Couches

```
src/
├── extension.ts        Point d'entrée : commandes, panneau, watcher
├── core/               Logique métier, sans dépendance à vscode
│   ├── model.ts        Le modèle commun aux deux sources
│   ├── acceptance.ts   Séparation description / critères d'acceptation
│   ├── html.ts         HTML Azure DevOps → markdown
│   ├── repoSlug.ts     Lecture des identifiants de dépôt GitHub
│   ├── storyCard.ts    Fabrication des fiches markdown
│   ├── localCards.ts   Fiches saisies à la main : stories et features
│   ├── workDir.ts      Lecture et écriture de .work
│   ├── claudeCli.ts    Vérification du CLI et appels claude -p
│   ├── plan.ts         Schémas du plan, lecture défensive, contrôles de forme
│   ├── planRender.ts   Plan → markdown, fiche de ready/ depuis le gabarit
│   ├── planStore.ts    .work/plans/<id>/ : état, versions, historique
│   ├── templates.ts    Gabarits du plan et du CR : ceux du dépôt, sinon par défaut
│   ├── planning.ts     L'atelier de planification, sans interface
│   ├── flowState.ts    state.json : le parcours des stories après Ready
│   ├── schedule.ts     Ordonnancement : dépendances retenues, fichiers occupés
│   ├── git.ts          Branches, worktrees, commits, diff, intégration, fast-forward
│   ├── devEnv.ts       Installation des dépendances, commandes autorisées
│   ├── supervision.ts  supervision.json, schémas, tri, fiches du tri, rapport
│   ├── orchestrator.ts De Ready à Done : file, dev, revue, supervision, merge
│   ├── resync.ts       Resynchronisation : relecture, bilan, replanification
│   └── notifications.ts Niveau de notifications, compte du badge
├── sources/            Les connecteurs de tickets, en lecture seule
│   ├── github.ts       Issue parente → sub-issues
│   ├── azureDevOps.ts  Work items ouverts, epic / feature → user stories
│   └── factory.ts      Choix de la source et résolution de l'accès
├── ui/                 Ce qui touche à l'interface VS Code
│   ├── flowTree.ts     Le panneau latéral
│   ├── importCommand.ts La commande d'import
│   ├── localCardCommands.ts Nouvelle story, nouvelle feature
│   ├── templatesCommand.ts Personnaliser les gabarits
│   ├── planningPanel.ts L'onglet de l'atelier (webview)
│   ├── devController.ts Dev, supervision et revue : commandes, journaux, barre d'état, badge
│   ├── resyncCommand.ts Resynchronisation, minuteur, « voir les changements »
│   └── storyDiff.ts    Le diff d'une story dans la vue native, contenu lu par git show
└── util/
    ├── config.ts       Paramètres et SecretStorage
    ├── exec.ts         Lancement de processus (git, claude)
    ├── files.ts        Écriture et lecture des fichiers d'état, sûres sous Windows
    └── resolveCommand.ts Trouver l'exécutable sous Windows, sans shell
resources/planning/     Script et styles de la page de l'atelier
```

`core/` ne connaît pas `vscode` : c'est là que vit la logique testable, et les
tests unitaires n'ont donc besoin d'aucun hôte VS Code. Les modules qui importent
`vscode` restent minces et se contentent de câbler.

## L'interface « source de tickets »

`TicketSource` expose trois opérations : `probe()` pour vérifier l'accès,
`fetchTree(rootId)` pour récupérer un ticket et sa descendance, et
`fetchTickets(ids)` pour relire des stories déjà importées, seules, à la
resynchronisation (voir [Resynchronisation](resynchronisation.md)). Une quatrième,
`listCandidates()`, propose les tickets ouverts en liste à cocher ; elle est
optionnelle, et sans elle l'import demande un identifiant. Les deux
implémentations produisent exactement les mêmes objets `Ticket`, si bien que le
reste de l'extension ignore d'où viennent les stories.

| | Azure DevOps | GitHub |
| --- | --- | --- |
| Point d'entrée | Epics, features et stories cochés dans la liste des work items ouverts, ou un ID | Issues cochées dans la liste des issues ouvertes, ou un numéro |
| Liste à cocher | Requête WIQL par catégories de types, états terminaux exclus, groupée par niveau | Issues ouvertes, filtre d'auteur, groupées selon qu'elles ont des sub-issues |
| Hiérarchie | Epic → feature → user story | Issue parente → sub-issues, sur plusieurs niveaux |
| Dépendances | Liens prédécesseur / successeur | `Blocked by #12` dans le corps |
| Critères d'acceptation | Champ dédié | Section `## Critères d'acceptation`, sinon vide |
| Story points, priorité | Champs natifs | Absents |
| Bibliothèque | `azure-devops-node-api` | `octokit` |

Le niveau d'un ticket GitHub se déduit de sa place dans l'arbre, parce que les
types d'issues n'existent qu'au niveau des organisations : la racine est l'epic,
puis feature, puis story, et une feuille est toujours une story.

Les parents directs des stories importées deviennent les fiches de
`.work/features` (`storyGroups` dans `core/mergeTrees.ts`), quel que soit leur
niveau chez la source : c'est ce qui range de la même façon, dans le panneau,
les stories importées des deux sources et celles saisies à la main.

La liste Azure DevOps s'appuie sur les catégories de types
(`Microsoft.EpicCategory`, `FeatureCategory`, `RequirementCategory`) pour
couvrir tous les processus, et exclut les états `Closed`, `Done` et `Removed`.
Un processus personnalisé aux états terminaux renommés laissera passer les
siens.

La liste à cocher écarte ce que `.work` connaît déjà (`alreadyImported` dans
`core/candidates.ts`) : une story dont la fiche existe, et un parent dont
chaque enfant a sa fiche, d'après le nombre d'enfants donné par la source. Un
parent à qui il manque une story reste proposé ; le crayon relit un ticket
masqué, pour une resynchronisation.

## Lecture seule chez la source

Aucun appel d'écriture n'existe dans les connecteurs. Les fiches saisies à la
main restent donc locales, avec un identifiant `LOCAL-<n>` pour une story et
`LOCAL-F<n>` pour une feature ; celles issues du tri du pre-pr-check (phase 3)
suivront la même numérotation. Le numéro suivant tient compte de toutes les
fiches du flux et des ateliers de `plans/`, pour qu'une story supprimée ne
lègue pas son atelier à la suivante.

## Contenu importé : une donnée, pas une instruction

La description d'une issue est du texte que n'importe qui peut écrire sur un
dépôt public. Deux parades :

1. `devbots.import.githubTrustedAuthorsOnly` n'importe que tes propres issues et
   celles portant le label de confiance ; la liste des issues ouvertes applique
   le même filtre et indique combien d'issues il masque ;
2. aux phases suivantes, ce contenu sera présenté aux agents comme une donnée à
   analyser, leurs commandes restant bornées à une liste autorisée.

## Processus externes

`util/exec.ts` lance `git` et `claude` par `spawn` **sans shell** : les arguments
passent tels quels, sans interprétation, ce qui ferme la porte à toute injection
par un titre de ticket ou un nom de branche.

Seule exception : l'installation des dépendances d'un worktree (`npm ci`,
`pnpm install`…) passe par le shell, parce que ces lanceurs passent par `node`.
La commande vient de tes paramètres ou du fichier de verrouillage, jamais d'un
ticket.

Sous Windows, une installation npm de Claude Code n'expose qu'un `claude.cmd`,
que Node refuse de lancer sans shell. `util/resolveCommand.ts` lit ce lanceur
pour y trouver le `claude.exe` qu'il appelle, et c'est lui qui est lancé : pas
de détour par `cmd.exe`, qui réinterpréterait les arguments.

## Appels à Claude

`core/claudeCli.ts` construit les appels `claude -p` : sortie
`--output-format json` avec un `--json-schema` imposé, `--resume` pour reprendre
une session, `--tools` pour borner les outils. Le prompt passe par l'entrée
standard, ce qui évite la limite de longueur de ligne de commande de Windows.
`--bare` n'est jamais utilisé : il contourne la connexion par abonnement.
Pour la même raison, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_USE_BEDROCK` et `CLAUDE_CODE_USE_VERTEX` sont retirées de
l'environnement du CLI (`subscriptionEnv`) : une clé présente sur le poste
n'est jamais utilisée.

L'atelier reçoit ce lanceur en paramètre (`ClaudeRunner`) : les tests le
remplacent par un faux qui rejoue des réponses, sans CLI.

Les agents de la phase 3 passent par `ClaudeStreamRunner` :
`--output-format stream-json --verbose`, chaque événement traduit en ligne de
journal (`parseStreamLine`), le dernier portant `structured_output` comme en
mode `json`. Leurs outils sont bornés par `--allowedTools` règle par règle, en
`--permission-mode default` : en `-p`, ce qui n'est pas autorisé est refusé,
et les refus remontent dans `permission_denials`.

## Fichiers d'état

`state.json` et `session.json` sont relus par le panneau à chaque changement.
Sous Windows, un fichier ouvert ne peut pas être remplacé par un renommage, et
des lectures rapprochées peuvent l'en empêcher sans fin : `util/files.ts`
tente le renommage, puis réécrit sur place, et la lecture relit un JSON lu en
pleine écriture.

## Atelier de planification

`core/planning.ts` tient l'atelier sans rien savoir de VS Code ;
`ui/planningPanel.ts` ne fait que relayer les gestes de la page et lui renvoyer
l'état. Le détail est dans [Planification](planification.md).

## Orchestrateur

`core/orchestrator.ts` tient le parcours de Ready à Done sans rien
savoir de VS Code ; `ui/devController.ts` relaie tes gestes et affiche les
événements. Le détail est dans [Dev et supervision](dev-et-supervision.md).

- `state.json` tient les états après Ready : `queued`, `in_dev`, `ai_review`,
  `pre_pr_check`, `awaiting_human`, `merging`, `done`, `blocked`. `new`,
  `planning` et `ready` se lisent dans les dossiers et dans `plans/`.
- L'ordonnancement (`core/schedule.ts`) est pur : il ne retient une
  dépendance déclarée que si le plan l'a confirmée, et refuse deux stories sur
  un même fichier.
- Les écritures de `state.json` s'enchaînent dans un seul `FlowStateStore` ;
  les lancements aussi (`pump`), si bien qu'une story ne démarre jamais deux
  fois.
- Les tests de l'orchestrateur tournent sur un vrai dépôt git temporaire, avec
  un faux CLI.
- Les merges s'enchaînent dans une seule file (`approve`), indépendante de
  celle des agents : jamais deux merges à la fois. Un conflit ou un check en
  échec remet la story dans la file des agents, avec ses corrections. Le
  détail est dans [Review et merge](review-et-merge.md).
