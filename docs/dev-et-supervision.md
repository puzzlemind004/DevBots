# Dev et supervision

Une story de Ready part en dev d'un clic, et revient « À valider » une fois
codée, relue et passée par les étapes de supervision du dépôt. Entre les deux,
l'extension tient tout ce qui est mécanique ; Claude code, relit et juge,
chaque fois dans une session neuve.

On lance une story par le bouton ▶ de Ready, ou par « DevBots : lancer le
dev ». Le modèle proposé est celui que recommande le plan ; tu peux en
choisir un autre.

## Déroulé

1. **File d'attente.** La story attend sa place : plafond d'agents
   (`devbots.agents.maxParallel`), dépendances, fichiers occupés. La raison de
   l'attente s'affiche dans l'infobulle.
2. **Préparation.** La branche de la feature (`feature/<id>-<slug>`) est créée
   depuis `devbots.git.baseBranch` (vide : la branche courante) si elle
   n'existe pas encore. La branche `story/<id>-<slug>` et son worktree en
   partent, dans `<dépôt>.worktrees/`. Les dépendances sont installées, puis
   les fichiers de la tâche déposés dans `.devbots/`.
3. **Dev.** `claude -p` dans le worktree, avec ton skill de dev
   (`devbots.dev.skill`). L'agent implémente, lance build et tests, rédige le
   CR dans `.devbots/cr.md`. Il ne commite pas : l'extension commite son
   travail à la fin de la session.
4. **Revue du CR.** Session neuve, en lecture seule, avec le plan, le CR et le
   diff. Réponse : approuvé, ou corrections bloquantes.
5. **Supervision.** Les étapes de `.work/supervision.json`, dans l'ordre,
   chacune dans une session neuve. Toutes répondent au même schéma : une liste
   de problèmes avec gravité, localisation et classement proposé.
6. **Tri.** Voir plus bas.
7. **À valider.** CR approuvé, rien de bloquant : la story attend ton feu
   vert, avec son CR et le rapport de supervision. Une notification te
   prévient.

## Boucle de correction

Les corrections bloquantes (revue du CR, étape bloquante) repartent à l'agent
de dev, dans **sa** session (`--resume`), avec ces seuls retours. Puis revue
et supervision recommencent, dans des sessions neuves.

Sans appel à Claude, l'extension renvoie aussi directement à l'agent : un
build ou des tests qu'il déclare en échec, un CR absent, un commit refusé par
un hook du dépôt.

Au-delà de `maxLoops` boucles (`.work/supervision.json`, sinon
`devbots.supervision.maxLoops`), la story passe bloquée et te revient. Les
corrections en suspens sont gardées : « Relancer » les renvoie à l'agent.

## Ordonnancement

- Une dépendance déclarée par la source n'est attendue que si le plan l'a
  confirmée : les deux stories touchent des fichiers ou des contrats communs.
  Une dépendance infirmée est « parallélisable d'après le code ».
- « Trancher une dépendance » (clic droit) te laisse l'attendre quand même, ou
  lever une dépendance confirmée.
- Deux stories qui touchent un même fichier (le champ `files` du plan) ne
  sont jamais en dev en même temps : la seconde attend que la première soit
  mergée.
- Une dépendance absente du flux est attendue, et signalée comme telle.

## Ce que l'agent de dev peut faire

| Outil | Limite |
| --- | --- |
| `Read`, `Grep`, `Glob`, `Edit`, `Write` | Le worktree |
| `Bash` | Les seules commandes de `devbots.dev.allowedCommands`, par préfixe |

Le mode de permission est `default` : en `-p`, tout ce qui n'est pas autorisé
est refusé, y compris la redirection d'un `echo` vers un fichier. Restent
refusés quoi qu'il arrive : `git push`, `git commit`, `git merge`,
`git rebase`, les changements de branche, `git worktree`, `ng serve` et
`npm start`. Les refus figurent au journal.

La revue du CR et les étapes de supervision n'ont que `Read`, `Grep` et
`Glob`, plus les règles que l'étape ajoute avec `tools`.

## `.devbots/` dans chaque worktree

| Fichier | Contenu |
| --- | --- |
| `story.md` | La fiche de `ready/` : la story et son plan validé |
| `plan.json` | Le plan structuré, quand la fiche en a un |
| `rules.md` | `devbots.dev.rulesFile`, s'il est renseigné |
| `cr-template.md` | Le gabarit de CR du dépôt, titre et identifiant remplis |
| `cr.md` | Le CR, écrit par l'agent |
| `diff-stat.txt`, `diff.patch` | Le diff de la story, pour la revue et la supervision |
| `installed` | Marque une installation des dépendances réussie |

Le dossier est exclu de git par `info/exclude`, partagé par tous les worktrees
du dépôt : rien n'est ajouté au `.gitignore` versionné.

## `.work/supervision.json`

« DevBots : personnaliser la supervision » dépose ce fichier :

```json
{
  "maxLoops": 3,
  "steps": [
    { "name": "pre-pr-check", "skill": "pre-pr-check", "blocking": true },
    {
      "name": "exemple-agent",
      "agent": "security-reviewer",
      "when": ["src/app/auth/**"],
      "blocking": false,
      "tools": [],
      "model": "opus",
      "disabled": true
    }
  ]
}
```

| Champ | Rôle |
| --- | --- |
| `skill` | Lancé par `/<skill>` en tête du prompt |
| `agent` | Agent de `.claude/agents/`, passé par `--agent`. Soit `skill`, soit `agent` |
| `when` | Motifs de fichiers : l'étape ne tourne que si la story en modifie un. Vide : toujours |
| `blocking` | Vrai par défaut. Faux : ses problèmes n'alimentent que le tri et le rapport |
| `tools` | Règles de permission en plus de la lecture seule, par exemple `Bash(npm run lint:*)` |
| `model` | Sinon `devbots.supervision.model` |
| `disabled` | Vrai : l'étape est ignorée |

Sans fichier, la supervision se réduit à `pre-pr-check`. Un skill ou un agent
introuvable dans `.claude/` donne un avertissement au journal, pas un blocage :
il peut venir d'un plugin ou de ton dossier utilisateur.

## Tri des problèmes

| Classement | Effet |
| --- | --- |
| `blocking`, d'une étape bloquante | Repart à l'agent de dev |
| `blocking`, d'une étape non bloquante | Fiche à planifier dans `new/` |
| `followup_complex` | Fiche à planifier dans `new/` |
| `followup_simple`, avec un mini-plan | Fiche prête dans `ready/`, modèle `haiku` |
| `followup_simple`, sans mini-plan | Fiche à planifier dans `new/` |
| `none` | Rapport seulement |

Le tri ne crée ses fiches qu'au dernier passage, quand plus rien ne bloque :
une boucle de correction ne les duplique pas. Les fiches portent un
identifiant `LOCAL-<n>`, la feature de la story d'origine, et `origin`
(l'étape) et `origin_story` dans leur frontmatter ; le panneau les marque du
nom de l'étape. « Reclasser la fiche » (clic droit) la fait passer de New à
Ready ou l'inverse, avant qu'elle parte en dev.

## `.work/state.json` et `.work/runs/<id>/`

`state.json` tient le parcours de chaque story partie en dev : état, modèle,
branches, worktree, session de l'agent, boucles, dernier statut de build et de
tests, fiches créées par le tri, et tes arbitrages sur les dépendances. Les
dossiers restent la source de vérité pour New, Ready et Done.

| État | Groupe du panneau |
| --- | --- |
| `queued`, `in_dev`, `ai_review`, `pre_pr_check`, `blocked` | En dev |
| `awaiting_human`, `merging` | À valider |
| `done` | Done |

`runs/<id>/` garde ce qu'il faut pour ta revue :

| Fichier | Contenu |
| --- | --- |
| `journal.log` | Le journal de l'agent, aussi suivi en direct par « Journal de l'agent » |
| `cr.md` | Copie du CR |
| `review.json` | La dernière revue du CR |
| `steps.json` | Les problèmes de chaque étape |
| `report.md` | Le rapport de supervision |

## Arrêt, reprise, redémarrage

- « Arrêter l'agent » interrompt le processus : la story passe bloquée, son
  worktree intact.
- « Relancer » la remet en file, compteur de boucles à zéro. L'agent reprend
  sa session et le travail en cours du worktree.
- « Retirer du flux de dev » rend à Ready une story en file, bloquée ou à
  valider, et libère ses fichiers ; son worktree et sa branche restent.
- Fermer VS Code arrête les agents. Au démarrage suivant, les stories
  interrompues passent bloquées et l'extension propose de tout relancer.

La barre d'état indique les agents actifs, les stories en file et celles qui
attendent ta revue.

## Ce qui viendra en phase 4

Ouvrir le worktree, voir le diff, renvoyer des retours, le feu vert et le
merge séquentiel avec rebase. D'ici là, une story « À valider » se relit et se
merge à la main depuis son worktree ; « Retirer du flux de dev » libère ensuite
ses fichiers pour les stories qui les attendent.
