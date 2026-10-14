# DevBots — guide de l'équipe

DevBots fait de notre process `.work` un flux guidé dans VS Code : import des
stories, planification avec Claude, dev par des agents dans des worktrees,
supervision, ta revue, merge. Les skills, les gabarits et le dossier `.work`
restent la référence : tout ce que fait l'extension se fait encore à la main.

## Prérequis

| Outil | Version | Vérification |
| --- | --- | --- |
| VS Code | 1.108 ou plus | Aide → À propos |
| Git | récent, avec `git worktree` | `git --version` |
| Claude Code (CLI) | 2.0.0 ou plus | `claude --version` |
| Node.js | celui du projet | les agents lancent `npm`, `npx ng`… |

Claude Code doit être **connecté avec ton abonnement** : lance `claude` une
fois dans un terminal, puis `/login`. L'extension ne passe jamais par une clé
d'API : `ANTHROPIC_API_KEY` et consorts sont retirées de l'environnement des
agents, même si elles sont définies sur ton poste.

## Installer

On ne passe pas par le Marketplace : l'extension se diffuse en fichier
`.vsix`.

1. Récupère `devbots-<version>.vsix` (canal de l'équipe).
2. Dans VS Code : vue Extensions → menu `…` → « Installer à partir de VSIX… »,
   ou en ligne de commande :

   ```bash
   code --install-extension devbots-0.1.0.vsix
   ```

3. Recharge la fenêtre. L'icône DevBots apparaît dans la barre d'activité dès
   qu'un dossier contient `.work`.

Mettre à jour : même chose avec le nouveau fichier, il remplace l'ancien. Les
stories en cours de dev sont reprises au redémarrage (bloquées, à relancer
d'un clic) ; leurs worktrees ne bougent pas.

### Fabriquer le `.vsix`

Pour qui maintient l'extension :

```bash
npm ci
npm run package   # typecheck, lint, tests, build, puis devbots-<version>.vsix
```

Pense à monter `version` dans `package.json` avant de diffuser.

## Configurer un dépôt

Le plus simple : « DevBots : installer le skill d'initialisation », puis
`/devbots-init` dans une session Claude Code à la racine du dépôt. Claude fait
l'état des lieux du dépôt, te demande ce que tu veux personnaliser (source,
skills de planification, de dev et de supervision, gabarits, commandes
autorisées…), construit avec toi les skills qui manquent et écrit les fichiers
ci-dessous. Le skill porte la liste des réglages et les gabarits par défaut de
la version installée de DevBots : réinstalle-le après une mise à jour.

Les étapes de DevBots sont réparties ainsi : l'extension tient le contrat de
chaque étape (entrées, format de sortie, git), les skills du dépôt tiennent la
méthode, et peuvent en appeler d'autres.

À la main :

Les réglages d'un dépôt vont dans son `.vscode/settings.json`, versionné :
toute l'équipe partage la même source, les mêmes commandes autorisées, les
mêmes checks.

```jsonc
{
  "devbots.source.kind": "azureDevOps",
  "devbots.azureDevOps.orgUrl": "https://dev.azure.com/<org>",
  "devbots.azureDevOps.project": "<projet>",
  "devbots.planning.skill": "plan-story",
  "devbots.dev.skill": "dev-story",
  "devbots.dev.allowedCommands": [
    "npx ng build",
    "npx ng test --watch=false",
    "npm run lint",
    "git status",
    "git diff",
    "git log",
    "git show"
  ],
  "devbots.merge.checkCommands": ["npx ng build", "npx ng test --watch=false"]
}
```

Le reste a des valeurs par défaut raisonnables ; la liste complète est dans le
[README](../README.md#configuration). Deux réglages sont propres à chaque
poste, à mettre dans tes paramètres utilisateur plutôt que dans le dépôt :

- `devbots.agents.maxParallel` : 2 par défaut. Un build Angular est gourmand,
  monte-le selon ta machine ;
- `devbots.notifications.level` : `all`, `actions` ou `none` (voir plus bas).

Les gabarits du plan et du CR (`.work/templates/`) et les étapes de
supervision (`.work/supervision.json`) se partagent aussi par le dépôt :
« DevBots : personnaliser les gabarits » et « … la supervision » les déposent
préremplis.

### Ton accès à la source

Chacun enregistre **son** jeton, en lecture seule, par « DevBots : enregistrer
un jeton d'accès ». Il reste dans le SecretStorage de VS Code, jamais dans le
dépôt ni dans `.work`.

- **Azure DevOps** : User settings → Personal access tokens → New token.
  Organisation du projet, portée **Work Items : Read**, rien d'autre. Note son
  expiration : un PAT expiré se signale à l'import.
- **GitHub** : la connexion GitHub de VS Code suffit. Sinon, un jeton à
  granularité fine sur le dépôt, **Issues : Read-only**.

## Le flux au quotidien

| Étape | Où | Ce que tu fais |
| --- | --- | --- |
| Import | ☁ du panneau | Coche les epics, features ou stories : leurs stories arrivent dans New |
| Planification | 💡 sur une story de New | Réponds aux questions, relis le plan section par section, « Passer en ready » |
| Dev | ▶ sur une story de Ready | Choisis le modèle ; l'agent code dans son worktree, le CR est relu, la supervision tourne |
| Revue | Carte « À valider » | Diff, application lancée sur son port, retours à l'agent ou feu vert |
| Merge | ✓ Feu vert | Merge dans la branche de la feature, nettoyage, fiche dans Done |

Le détail de chaque étape : [Planification](planification.md),
[Dev et supervision](dev-et-supervision.md), [Review et merge](review-et-merge.md).

Quelques règles qui évitent les surprises :

- **une story, un worktree** : ne code pas dans le worktree d'une story dont
  l'agent tourne ; à la revue, tes retouches y sont bienvenues et partent avec
  la story ;
- **les merges sont locaux**, dans la branche de la feature, sans pull request.
  La PR de la feature vers `main` reste à faire comme d'habitude ;
- **l'extension n'écrit jamais chez la source** : passer le ticket en Done
  dans Azure DevOps reste à faire à la main.

## Quand la story change chez la source

Lance ⟳ « resynchroniser avec la source » (menu `…` du panneau) : une story
déjà planifiée qui a changé chez la source passe « à revoir ». « Voir les
changements » montre la différence ; tu gardes le plan, ou tu replanifies.
Pas de vérification automatique par défaut. Le détail :
[Resynchronisation](resynchronisation.md).

## Notifications

Le **badge** de l'icône DevBots compte les stories qui t'attendent : à
valider, bloquées, à revoir. La **barre d'état** donne les agents actifs, la
file et les stories à valider. Les deux sont toujours à jour.

Les notifications se règlent par `devbots.notifications.level` :

| Niveau | Ce qui notifie |
| --- | --- |
| `all` (défaut) | Tout : revue attendue, blocage, merge, retour à l'agent après un conflit, changement chez la source |
| `actions` | Ce qui attend un geste : revue attendue, blocage, merge impossible ou nettoyage incomplet, changement chez la source |
| `none` | Rien : le badge suffit |

Les erreurs d'une commande que tu lances s'affichent toujours.

## En cas de souci

| Symptôme | Piste |
| --- | --- |
| « Claude Code introuvable » ou « trop ancien » | `claude --version` dans un terminal ; sinon `devbots.claude.executable` vers le bon chemin. « DevBots : vérifier l'installation de Claude Code » reteste |
| Les agents consomment un crédit d'API | Ils ne le peuvent pas : vérifie `claude` → `/status`, connecté par abonnement |
| Import Azure DevOps refusé (401) | PAT expiré ou sans la portée Work Items : réenregistre-le |
| Une story reste bloquée | Clic sur la story → journal de l'agent ; « Relancer » reprend sa session |
| Une commande de l'agent est refusée | Elle n'est pas dans `devbots.dev.allowedCommands` : ajoute-la au dépôt si elle doit l'être |
| Le port de l'application est pris | `devbots.review.basePort`, ou ferme l'application d'une revue précédente |
| VS Code fermé pendant un dev | Au redémarrage, les stories interrompues sont proposées à la relance ; leur worktree est intact |

Le journal de l'extension est dans le panneau Sortie, canal **DevBots** ;
celui de chaque agent, dans **DevBots · <id>**. Joins-les à toute remontée de
bug.
