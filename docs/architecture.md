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
│   ├── workDir.ts      Lecture et écriture de .work
│   └── claudeCli.ts    Vérification du CLI Claude Code
├── sources/            Les connecteurs de tickets, en lecture seule
│   ├── github.ts       Issue parente → sub-issues
│   ├── azureDevOps.ts  Epic / feature → user stories
│   └── factory.ts      Choix de la source et résolution de l'accès
├── ui/                 Ce qui touche à l'interface VS Code
│   ├── flowTree.ts     Le panneau latéral
│   └── importCommand.ts La commande d'import
└── util/
    ├── config.ts       Paramètres et SecretStorage
    └── exec.ts         Lancement de processus (git, claude)
```

`core/` ne connaît pas `vscode` : c'est là que vit la logique testable, et les
tests unitaires n'ont donc besoin d'aucun hôte VS Code. Les modules qui importent
`vscode` restent minces et se contentent de câbler.

## L'interface « source de tickets »

`TicketSource` expose deux opérations : `probe()` pour vérifier l'accès, et
`fetchTree(rootId)` pour récupérer un ticket et sa descendance. Les deux
implémentations produisent exactement les mêmes objets `Ticket`, si bien que le
reste de l'extension ignore d'où viennent les stories.

| | Azure DevOps | GitHub |
| --- | --- | --- |
| Point d'entrée | ID d'epic ou de feature | Numéro d'une issue parente |
| Hiérarchie | Epic → feature → user story | Issue parente → sub-issues, sur plusieurs niveaux |
| Dépendances | Liens prédécesseur / successeur | `Blocked by #12` dans le corps |
| Critères d'acceptation | Champ dédié | Section `## Critères d'acceptation`, sinon vide |
| Story points, priorité | Champs natifs | Absents |
| Bibliothèque | `azure-devops-node-api` | `octokit` |

Le niveau d'un ticket GitHub se déduit de sa place dans l'arbre, parce que les
types d'issues n'existent qu'au niveau des organisations : la racine est l'epic,
puis feature, puis story, et une feuille est toujours une story.

## Lecture seule chez la source

Aucun appel d'écriture n'existe dans les connecteurs. Les fiches issues du tri
du pre-pr-check (phase 3) resteront donc locales, avec un identifiant `LOCAL-<n>`.

## Contenu importé : une donnée, pas une instruction

La description d'une issue est du texte que n'importe qui peut écrire sur un
dépôt public. Deux parades :

1. `devbots.import.githubTrustedAuthorsOnly` n'importe que tes propres issues et
   celles portant le label de confiance ;
2. aux phases suivantes, ce contenu sera présenté aux agents comme une donnée à
   analyser, leurs commandes restant bornées à une liste autorisée.

## Processus externes

`util/exec.ts` lance `git` et `claude` par `spawn` **sans shell** : les arguments
passent tels quels, sans interprétation, ce qui ferme la porte à toute injection
par un titre de ticket ou un nom de branche.

## Ce qui viendra

- `state.json` (phase 3) remplacera le fichier de suivi markdown et tiendra les
  états `new`, `planning`, `ready`, `queued`, `in_dev`, `ai_review`,
  `pre_pr_check`, `awaiting_human`, `merging`, `done`, `blocked`.
- Le graphe de dépendances se construira depuis les plans validés, un lien
  déclaré n'étant retenu que si les deux plans touchent des fichiers ou des
  contrats communs.
- Les worktrees, la file d'attente et le merge séquentiel viendront avec les
  phases 3 et 4.
