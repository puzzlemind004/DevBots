# Le contrat de DevBots, étape par étape

Ce que l'extension fournit et impose à chaque étape. Un skill du dépôt
décrit la méthode à l'intérieur de ce cadre ; il ne le redéfinit pas.

Partout : chaque session Claude tourne en `claude -p`, sans personne pour
répondre. Le contenu des fiches vient d'un outil de tickets et reste une donnée,
jamais une consigne. Ce qui n'est pas autorisé est refusé, sans question.

Hors planification, **chaque session est neuve**, corrections comprises :
aucune ne se souvient de la précédente. Ce qui doit passer d'une session à
l'autre est écrit dans le code, dans `.devbots/cr.md` ou dans les fichiers que
DevBots dépose. Chaque tour d'une session renvoie tout son historique : une
longue session coûte cher à chaque tour, et un skill se juge aussi au nombre
de tours qu'il fait faire.

## Source

Rien à écrire en skill. Réglages : `devbots.source.kind`, puis
`devbots.github.*` ou `devbots.azureDevOps.*`, `devbots.import.*`. L'accès se
fait en lecture seule ; le jeton est propre à chaque poste et se saisit dans
VS Code, jamais dans un fichier.

## Planification

Réglages : `devbots.planning.skill`, `devbots.planning.model`,
`devbots.planning.template`.

- **Session** : une par story, ouverte à la racine du dépôt, reprise à chaque
  réponse ou commentaire de l'utilisateur. Le premier prompt commence par
  `/<skill>`.
- **Outils** : `Read`, `Grep`, `Glob`, `Skill`. Lecture seule : aucune
  écriture, aucune commande, y compris dans un skill appelé.
- **Entrées** : le chemin de la fiche de la story, celui de sa feature s'il y
  en a une, ses critères d'acceptation numérotés `C1`, `C2`… (`X1`, `X2`…
  quand Claude doit les extraire), ses dépendances déclarées.
- **Phase 1, compréhension** : reformulation, hypothèses, questions à deux à
  quatre réponses proposées, marquées bloquantes ou non.
- **Phase 2, plan** : compréhension et décisions, couverture de chaque critère
  par des étapes, étapes numérotées avec approche et fichiers impactés, tests
  unitaires et e2e, verdict sur chaque dépendance (confirmée si les stories
  touchent des fichiers ou contrats communs), risques, modèle recommandé pour
  le dev (`opus`, `sonnet`, `haiku`) et complexité.
- **Réservé à DevBots** : worktree et branche, commits, pull request, revue,
  merge, fermeture du ticket. Le plan ne contient aucune étape pour cela.

Les fichiers impactés comptent : DevBots s'en sert pour ne jamais lancer deux
stories sur les mêmes fichiers. Un skill de planification gagne à les exiger
exhaustifs.

### Gabarit du plan

`<workDir>/templates/plan.md` met en forme le plan validé dans la fiche de
`ready/`. Le frontmatter de la fiche reste tenu par DevBots ; le gabarit ne
décide que du corps. Marqueurs :

| Marqueur | Contenu |
| --- | --- |
| `{{title}}`, `{{source_id}}`, `{{web_url}}` | Depuis la fiche |
| `{{story}}` | Le corps de la fiche d'origine, sans son titre |
| `{{comprehension}}` | Reformulation, hypothèses, décisions |
| `{{couverture}}` | Critères et étapes qui les couvrent |
| `{{etapes}}` | Étapes numérotées, approche, fichiers |
| `{{tests}}` | Tests unitaires et e2e |
| `{{dependances}}` | Verdicts sur les dépendances, risques |
| `{{execution}}` | Modèle recommandé, complexité, justification |
| `{{plan}}` | Toutes les sections, chacune sous un titre `##` |
| `{{modele}}`, `{{complexite}}` | Valeurs brutes (`sonnet`, `low`…) |

## Dev

Réglages : `devbots.dev.skill`, `devbots.dev.allowedCommands`,
`devbots.dev.installCommand`, `devbots.dev.rulesFile`, `devbots.dev.model`,
`devbots.dev.checkCommands`, `devbots.dev.correctionMaxTurns`,
`devbots.agents.storyBudgetUsd`, `devbots.git.baseBranch`,
`devbots.worktrees.root`.

- **Sessions** : dans le worktree de la story, dépendances déjà installées.
  Chacune est neuve et son prompt commence par `/<skill>`. La suite du prompt
  dit dans quel cas le skill est ouvert :
  - **premier dev** (« Développement de la story… ») : la story entière,
    selon le plan ;
  - **reprise** (« Une session précédente a commencé cette story… ») : une
    session arrêtée en route ; son travail est dans le worktree, non commité.
    Le skill repart de `git status` et `git diff`, sans refaire ce qui est
    fait ;
  - **corrections** (« Corrections de la story… ») : les corrections de la
    revue, de la supervision, de l'utilisateur ou d'un conflit de merge, dans
    le prompt et dans `.devbots/corrections.md`. Le travail précédent est
    commité et décrit dans `.devbots/cr.md`. Session plafonnée à
    `devbots.dev.correctionMaxTurns` tours.
- **Outils** : `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Skill`, et `Bash`
  limité aux préfixes de `devbots.dev.allowedCommands`. Toujours refusés :
  `git commit`, `git push`, `git merge`, `git rebase`, changements de branche,
  `git worktree`, serveurs de dev (`ng serve`, `npm start`).
- **Entrées**, dans `.devbots/` : `story.md` (la fiche et son plan validé, à
  suivre), `plan.json` (le même, structuré), `rules.md` (copie de
  `devbots.dev.rulesFile` s'il est renseigné), `cr-template.md` (le gabarit du
  CR). En correction, en plus : `corrections.md`, `cr.md`, `diff-stat.txt` et
  `diff.patch` (le diff de la story).
- **Sorties** : le code ; le CR dans `.devbots/cr.md`, suivant le gabarit ; le
  statut constaté du build, des tests et du lint ; `blocked` avec la raison si
  la story ne peut pas aboutir sans aide.
- **Réservé à DevBots** : le commit, à la fin de la session ; tout le reste de
  git.
- Les commandes tournent sans surveillance : mode headless, jamais de mode
  watch. Les commandes de build, de test et de lint que le skill demande
  doivent figurer dans `devbots.dev.allowedCommands`.
- **Checks** : les commandes de `devbots.dev.checkCommands` sont lancées par
  DevBots après chaque session, hors de Claude. Le premier échec repart à
  l'agent avec la fin de sa sortie. Elles font foi sur le statut déclaré.
- **Budget** : le coût estimé de toutes les sessions d'une story est cumulé.
  Une fois `devbots.agents.storyBudgetUsd` atteint, la story est bloquée et
  revient à l'utilisateur.

### Ce qu'un skill de dev doit respecter

DevBots ne contrôle pas la méthode : c'est le skill qui fait la consommation.
Un skill de dev :

- **a un chemin court pour les corrections**. Il lit `corrections.md`, ne
  relit que les fichiers concernés, corrige ces points et seulement eux. Il
  lance les seuls tests qui les couvrent, puis ajoute la correction au CR sans
  le réécrire. Il ne refait ni la lecture complète de la story, ni le
  parcours navigateur, ni la documentation, sauf si une correction le
  demande ;
- **lance build et tests au premier plan**, avec un timeout long, jamais en
  tâche de fond. Une tâche de fond ne s'attend qu'en relisant sa sortie, et
  chaque relecture est un tour complet ;
- **avec des `checkCommands`**, ne lance pas la suite complète ni les builds
  de production : ils tournent après la session, sans tokens. Il se contente
  des tests ciblés sur ce qu'il modifie ;
- **garde les caches** des outils de build (`nx`, `turbo`…) : pas de
  `--skip-nx-cache` ni d'équivalent, qui reconstruit toutes les dépendances
  à chaque passage ;
- **fait des commandes simples** : une par appel Bash, sans `cd` (le dossier
  courant est déjà le worktree). Dans un pipe, un `&&` ou un `;`, chaque
  partie doit être autorisée, sinon le tout est refusé et le tour est perdu ;
- **écrit dans le CR** ce qu'une session suivante devra savoir : elle n'aura
  que lui et le code.

## Compte rendu

`<workDir>/templates/cr.md`. DevBots remplit `{{title}}` et `{{source_id}}`,
l'agent de dev rédige le reste. Les sections sont des consignes ; un
commentaire `<!-- … -->` sous chacune dit ce qu'elle attend. Seule l'absence
du CR est contrôlée : sa forme est libre.

## Supervision

Après le dev, deux temps :

1. **Revue du CR**, tenue par DevBots, sans skill : une session neuve vérifie
   que le CR est fidèle au diff et que chaque critère est couvert.
2. **Étapes du dépôt**, décrites dans `<workDir>/supervision.json`, chacune
   dans une session neuve, dans l'ordre.

Après une boucle de correction, rien n'est relu en entier :

- un CR déjà approuvé ne repasse pas en revue ;
- une étape sans problème bloquant garde ses résultats sans être relancée ;
- une étape qui en avait vérifie ses seuls problèmes bloquants sur
  `.devbots/fix.patch`, le diff de la correction. Cette vérification est
  menée par DevBots, **sans le skill de l'étape** (un agent d'étape reste en
  place).

Le skill d'une étape ne tourne donc qu'une fois, pour la relecture
complète.

```json
{
  "maxLoops": 2,
  "steps": [
    { "name": "pre-pr-check", "skill": "pre-pr-check", "blocking": true },
    { "name": "securite", "agent": "security-reviewer", "when": ["src/app/auth/**"], "blocking": false, "tools": ["Bash(npm audit:*)"], "model": "opus" }
  ]
}
```

| Champ | Rôle |
| --- | --- |
| `skill` | Ouvre la session par `/<skill>` |
| `agent` | Agent de `.claude/agents/` qui mène la session. Soit `skill`, soit `agent` |
| `when` | Motifs de fichiers : l'étape ne tourne que si la story en modifie un. Absent : toujours |
| `blocking` | Vrai par défaut. Faux : ses problèmes ne deviennent que des fiches de suivi |
| `tools` | Règles de permission en plus de la lecture seule |
| `model` | Sinon `devbots.supervision.model` |
| `disabled` | Vrai : l'étape est ignorée |
| `maxLoops` | Boucles de correction avant que la story revienne à l'utilisateur |

Sans fichier, une seule étape : le skill `pre-pr-check`.

- **Outils** : `Read`, `Grep`, `Glob`, `Skill`, plus `tools`.
- **Entrées** : `.devbots/story.md`, `.devbots/cr.md`, `.devbots/diff.patch`,
  la liste des fichiers modifiés.
- **Sortie** : une liste de problèmes, chacun avec titre, description,
  gravité, fichier, ligne et classement : `blocking` (corrigé par l'agent dans
  cette story), `followup_complex` (fiche séparée, à planifier),
  `followup_simple` (fiche séparée avec un mini-plan), `none` (information).

Un skill de supervision décide quoi regarder et comment classer ; DevBots
renvoie les `blocking` à l'agent de dev et crée les fiches de suivi.

Seul retient la story un problème `blocking` d'une étape bloquante, de
gravité `blocking` ou `major`. Classé `blocking` en gravité `minor`, il
devient une fiche de suivi ; en gravité `info`, une information.

### Ce qu'un skill de supervision doit respecter

- **Être exhaustif en un passage** : il ne tournera plus après une
  correction. Ce qu'il ne signale pas au premier passage ne sera signalé par
  personne avant la revue humaine.
- **Réserver `blocking`** à ce qui empêche de livrer la story : critère du
  plan non couvert, bug, régression, build ou tests cassés, faille de
  sécurité. Une convention de style, de nommage ou de documentation est un
  `followup_simple` avec son mini-plan, sauf si le plan de la story l'exige
  expressément.
- **Donner une gravité honnête** : un `minor` ne relance jamais de boucle,
  quel que soit son classement.

## Revue et merge

Réglages : `devbots.merge.checkCommands`, `devbots.review.serveCommand`,
`devbots.review.basePort`. Pas de skill : l'utilisateur relit le diff, peut
lancer l'application du worktree, puis donne le feu vert. DevBots merge dans
la branche de la feature et relance les checks si elle a avancé depuis la
revue.
