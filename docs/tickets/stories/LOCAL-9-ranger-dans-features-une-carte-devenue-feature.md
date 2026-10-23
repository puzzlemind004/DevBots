---
source: "local"
source_id: "LOCAL-9"
parent: "LOCAL-F2"
created_at: "2026-10-23T14:00:00.000Z"
title: "Ranger dans features/ à la synchro une carte de new/ reconnue comme feature"
state: "open"
dependencies:
  - "LOCAL-6"
---

# Ranger dans features/ à la synchro une carte de new/ reconnue comme feature

## Description

Les imports déjà faits ont laissé des features dans `.work/new/`, comme
46491. Une fois la détection corrigée (LOCAL-6), la synchro doit les remettre
à leur place.

Aujourd'hui `resyncStories` (`src/core/resync.ts`) relit les fiches de `new/`
et `ready/` et les réécrit par `importTickets` comme des stories, quel que
soit le niveau du ticket reçu.

Nouveau comportement, à la synchro, pour un ticket relu dont le niveau n'est
plus `story` :

- fiche dans `new/`, **ni planifiée ni démarrée** (aucune session d'atelier en
  cours ou passée dans `PlanStore`, pas d'entrée dans `state.json`) : la fiche
  de `new/` est supprimée, la feature est écrite dans `.work/features/` (gabarit
  de feature), et le canal de sortie le dit ;
- sinon (atelier entamé, fiche dans `ready/`, ou story partie en dev) : rien ne
  bouge, et DevBots le signale (notification et canal de sortie) en nommant la
  carte, pour que l'utilisateur tranche, par exemple en la supprimant.

Une fiche de `features/` n'est proposée ni à la planification ni au dev : à
vérifier dans les `when` de `package.json` et dans les commandes
`devbots.planStory` et `devbots.startDev`, qui doivent refuser une feature.

## Critères d'acceptation

- À la synchro, une carte de `new/` reconnue comme feature, jamais planifiée, passe dans `.work/features/` et quitte `new/`.
- Ses stories enfants de `new/` se rangent sous elle dans le panneau, sans autre action.
- Une carte reconnue comme feature mais déjà planifiée, en cours d'atelier ou démarrée ne bouge pas, et un avertissement nomme la carte.
- L'avertissement n'est pas répété à chaque synchro automatique : une seule fois par carte et par session de VS Code.
- `devbots.planStory` et `devbots.startDev` refusent une fiche de `features/`, même lancées depuis la palette avec son chemin.
- Les stories relues par la synchro qui restent de niveau `story` se comportent comme avant.
- Tests unitaires : carte devenue feature non démarrée, puis démarrée.
