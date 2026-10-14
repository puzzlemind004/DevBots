---
name: devbots-init
description: Prépare ce dépôt pour l'extension DevBots — source des tickets, skills de planification, de dev et de supervision, gabarits, commandes autorisées — en interrogeant l'utilisateur étape par étape.
disable-model-invocation: true
---

# Initialiser DevBots dans ce dépôt

DevBots est une extension VS Code qui organise le travail avec Claude : import
des tickets, planification, dev dans un worktree, supervision, revue, merge.
L'extension tient le **contrat** de chaque étape (ses entrées, son format de
sortie, ce qu'elle fait elle-même). Le dépôt tient la **méthode** : ses skills,
ses gabarits, ses réglages. Ta mission : construire avec l'utilisateur la
méthode du dépôt, puis écrire les fichiers qui la portent, pour que
l'extension soit prête à l'emploi à la fin de cette session.

Fichiers de ce skill, à côté de celui-ci :

- [`parametres.md`](parametres.md) : chaque réglage `devbots.*`, sa portée, sa
  valeur par défaut. Lis-le avant d'écrire un réglage.
- [`contrat.md`](contrat.md) : ce que DevBots impose à chaque étape. Lis la
  section d'une étape avant d'en écrire le skill ou le gabarit.
- `defauts/` : les gabarits par défaut (`plan.md`, `cr.md`) et la supervision
  par défaut (`supervision.json`), base de toute personnalisation.

Pose tes questions une à une, chacune avec des réponses proposées tirées de ce
que tu as observé dans le dépôt, et ta recommandation en premier. L'utilisateur
peut toujours répondre « garder le défaut » : c'est un choix valable, à noter
comme tel.

## 1. État des lieux

Sans rien demander, relève :

- `.vscode/settings.json` : les clés `devbots.*` déjà présentes ;
- le dossier du flux (`devbots.workDir`, `.work` par défaut) : `templates/`,
  `supervision.json` ;
- `.claude/skills/`, `.claude/commands/`, `.claude/agents/`, `CLAUDE.md`, et
  les docs de dev qu'il cite ;
- le remote `origin` (GitHub ou Azure DevOps), la branche courante ;
- la stack : `package.json` et ses scripts, fichier de verrouillage, autres
  projets dans les sous-dossiers, commandes de build, de test et de lint.

Terminé quand tu peux présenter à l'utilisateur un tableau des domaines de
l'étape 2, chacun marqué « déjà configuré », « défaut » ou « à décider », avec
ce que tu as trouvé.

## 2. Choix des domaines

Présente le tableau et demande quels domaines l'utilisateur veut personnaliser
maintenant :

| Domaine | Ce qui se décide |
| --- | --- |
| Source | GitHub ou Azure DevOps, dépôt ou organisation et projet, filtre de confiance |
| Planification | Skill de planification, modèle, gabarit du plan |
| Dev | Skill de dev, commandes autorisées, checks lancés par DevBots, installation des dépendances, règles, branche de base, modèle |
| Compte rendu | Gabarit du CR |
| Supervision | Étapes (skills ou agents), conditions, caractère bloquant, boucles de correction |
| Revue et merge | Checks relancés au merge, commande qui sert l'application, port |
| Poste | Agents en parallèle, budget par story, notifications : paramètres utilisateur, ou du dépôt si l'équipe le partage |

La source se configure toujours : sans elle, rien ne s'importe.

## 3. Chaque domaine retenu

Traite les domaines dans l'ordre du tableau. Pour chacun :

1. relis sa section de [`contrat.md`](contrat.md) ;
2. pose les questions qui fixent ses réglages, en partant de ce que l'état des
   lieux a montré (par exemple, les commandes autorisées se proposent depuis
   les scripts réels du dépôt, et `devbots.dev.checkCommands` depuis ses
   commandes de build et de test complètes, cache compris) ;
3. si le domaine a un skill, mène l'**entretien de skill** ci-dessous ;
4. si le domaine a un gabarit, pars de celui de `defauts/` et adapte-le avec
   l'utilisateur ;
5. montre le résultat (réglages, skill, gabarit) et fais-le valider avant de
   passer au domaine suivant.

### Entretien de skill

Un skill d'étape décrit la méthode de l'équipe pour cette étape. Commence par
proposer de réutiliser un skill existant de `.claude/skills/` qui couvre déjà
l'étape. Sinon, interroge l'utilisateur jusqu'à savoir :

- comment l'équipe mène cette étape aujourd'hui, à la main ;
- les docs, conventions et zones du code à lire d'abord ;
- les autres skills du dépôt à appeler, et à quel moment ;
- ce qui distingue un bon résultat d'un mauvais pour cette équipe.

Un skill existant, réutilisé ou non, se relit contre la section « Ce qu'un
skill de … doit respecter » de son étape dans [`contrat.md`](contrat.md) :
chemin court pour les corrections, commandes au premier plan, caches gardés,
définition stricte du bloquant. Propose à l'utilisateur d'ajuster ce qui s'en
écarte : c'est ce qui décide de ce que coûte une story.

Rédige ensuite `.claude/skills/<nom>/SKILL.md` : la méthode seule, le contrat
étant fourni par DevBots à chaque session. Un skill de dev traite les trois
cas d'ouverture du contrat (premier dev, reprise, corrections), chacun dans sa
section, la section des corrections restant la plus courte. Une étape que le contrat réserve à
DevBots (commit, pull request, merge…) n'y figure pas ; un format de sortie non
plus, il est imposé. Donne-lui `disable-model-invocation: true` : c'est DevBots
qui l'ouvre, par `/<nom>`. Les skills qu'il appelle passent par l'outil
`Skill`, qui ne voit que les skills invocables par le modèle : ceux-là gardent
une `description` et pas de `disable-model-invocation`.

## 4. Écriture

Une fois tous les domaines validés, écris :

- les réglages de dépôt dans `.vscode/settings.json`, en ne touchant qu'aux
  clés `devbots.*` et en gardant le reste du fichier, commentaires compris ;
- les réglages de poste dans les paramètres utilisateur de VS Code, seulement
  si l'utilisateur te le demande, sinon donne-lui les valeurs à y mettre ;
- les gabarits dans `<workDir>/templates/plan.md` et `cr.md` ;
- la supervision dans `<workDir>/supervision.json` ;
- les skills dans `.claude/skills/`.

Crée le dossier du flux s'il n'existe pas : c'est sa présence qui fait
apparaître le panneau DevBots.

## 5. Bilan

Termine par un tableau : chaque domaine, ce qui a été écrit (fichier et
réglages) ou « défaut gardé ». Puis la liste de ce qui reste à faire à la main :

- recharger la fenêtre VS Code ;
- « DevBots : vérifier l'installation de Claude Code » ;
- Azure DevOps, ou GitHub sans la connexion GitHub de VS Code : « DevBots :
  enregistrer un jeton d'accès », jeton en lecture seule sur les tickets ;
- versionner les fichiers écrits, pour que l'équipe les partage ;
- premier essai : importer une story et la planifier.

Terminé quand chaque domaine retenu à l'étape 2 est écrit ou marqué
« défaut gardé », et que l'utilisateur a la liste des gestes restants.
