---
source: "local"
source_id: "LOCAL-6"
parent: "LOCAL-F2"
created_at: "2026-10-23T14:00:00.000Z"
title: "Reconnaître le niveau d'un work item par les catégories de backlog Azure"
state: "open"
---

# Reconnaître le niveau d'un work item par les catégories de backlog Azure

## Description

Bug : la feature 46491 « Gestion des CNILs », d'un type personnalisé, est
importée comme une story dans `.work/new/`, à côté de ses enfants, et
`.work/features/` reste vide. `levelForType` (`src/sources/azureDevOps.ts`) ne
reconnaît que les types nommés exactement « Epic » et « Feature » ; tout le
reste devient une story.

Le niveau se détermine désormais dans cet ordre :

1. **Réglage** `devbots.azureDevOps.workItemTypes`, qui force la correspondance :

   ```jsonc
   "devbots.azureDevOps.workItemTypes": {
     "Feature Front": "feature",
     "Story Front": "story"
   }
   ```

2. **Catégories de backlog** du projet, qui rattachent chaque type, même personnalisé, à un niveau :

   ```
   GET {orgUrl}/{project}/_apis/wit/workitemtypecategories?api-version=7.1
   ```

   | Catégorie Azure | Niveau DevBots |
   |---|---|
   | `Microsoft.EpicCategory` | `epic` |
   | `Microsoft.FeatureCategory` | `feature` |
   | `Microsoft.RequirementCategory` | `story` |

   Résultat en cache le temps d'un import ou d'une synchro.

3. **Comparaison actuelle** sur le nom (`Epic`, `Feature`).

Un type reconnu par aucun des trois devient une story, avec **un
avertissement** dans le canal de sortie qui nomme le type et le réglage à
renseigner (une fois par type et par import).

La détection sert partout où `levelForType` est appelé : `toTicket` (import,
synchro) et `toCandidate` (la liste à cocher de l'import, rangée par niveau
dans `src/ui/importCommand.ts`). `storyGroups` (`src/core/mergeTrees.ts`)
range alors la feature dans `.work/features/` sans autre changement.

Une feature importée n'est jamais une carte planifiable ni développable : elle
ne doit pas arriver dans `new/`. Seuls les tickets `story` partent dans
`importTickets` (`src/ui/importCommand.ts`) : à vérifier.

Documenter le réglage dans le README.

## Critères d'acceptation

- Une feature d'un type personnalisé rattaché à `Microsoft.FeatureCategory` est rangée dans `.work/features/`, sans aucun réglage ; ses stories sont dans `.work/new/` avec `parent` pointant vers elle.
- Import d'une feature et de trois stories : un fichier dans `features/`, trois dans `new/`, aucun fichier de la feature dans `new/`.
- `devbots.azureDevOps.workItemTypes` l'emporte sur les catégories.
- Sans réglage ni catégorie, les types « Epic » et « Feature » restent reconnus par leur nom.
- Un type reconnu par aucun des trois donne une story et un avertissement unique qui nomme le type et le réglage `devbots.azureDevOps.workItemTypes`.
- Les catégories ne sont lues qu'une fois par import ou par synchro.
- La liste à cocher de l'import range la feature personnalisée sous « Features ».
- Un échec de lecture des catégories n'empêche pas l'import : il est écrit dans le canal de sortie, et la détection se replie sur le réglage puis sur le nom.
- Le connecteur GitHub et les features locales `LOCAL-F…` ne changent pas.
- Tests unitaires : type standard, type personnalisé rattaché à une catégorie, type forcé par réglage, type inconnu.
