---
source: "local"
source_id: "LOCAL-4"
parent: "LOCAL-F1"
created_at: "2026-10-23T14:00:00.000Z"
title: "Recueillir sous « Autres champs » les champs HTML non lus"
state: "open"
dependencies:
  - "LOCAL-3"
---

# Recueillir sous « Autres champs » les champs HTML non lus

## Description

Aujourd'hui, un champ que DevBots ne lit pas disparaît sans avertissement : il
faut comparer à la main avec Azure pour s'en apercevoir. Un champ ajouté plus
tard au formulaire doit apparaître tout de suite, même avant qu'on mette à jour
`devbots.azureDevOps.fields`.

Deux nouveaux réglages :

- `devbots.azureDevOps.includeUnmappedRichTextFields` (booléen, **`true` par défaut**) : tout champ de **type** HTML (LOCAL-1) non vide, qui n'est ni lu (par défaut ou par le réglage), ni exclu, est ajouté en fin de fiche sous `## Autres champs`, une sous-section `###` par champ, titrée avec son libellé Azure ;
- `devbots.azureDevOps.excludedFields` (liste de noms de référence), par défaut `["System.History"]` : la discussion du work item est en HTML mais n'a pas sa place dans la fiche.

La section se place après les critères d'acceptation : avant les dépendances
déclarées et les pièces jointes, ou juste avant le lien vers la source, à
trancher à la planification. Les sections de rôle restent intactes. Le repli
vaut pour tous les niveaux, y compris les features (voir LOCAL-7).

Points d'entrée : `toTicket` (`src/sources/azureDevOps.ts`), `renderStoryCard`
(`src/core/storyCard.ts`), `package.json`, `src/util/config.ts`, README,
`docs/format-fiches.md`.

## Critères d'acceptation

- Avec le repli actif (défaut), un champ HTML non vide, ni lu ni exclu, apparaît sous `## Autres champs`, dans une sous-section titrée avec son libellé Azure.
- Avec le repli désactivé, il n'apparaît pas.
- `System.History` n'apparaît jamais avec les réglages par défaut.
- Un champ listé dans `excludedFields` n'apparaît pas ; remplacer la liste par `[]` fait apparaître `System.History`.
- Un champ déjà lu (description, critères, champ configuré) n'est pas répété sous « Autres champs ».
- Un champ texte simple ou numérique non lu n'apparaît pas : seul le type HTML compte, pas le contenu.
- Sans aucun champ à recueillir, la section « Autres champs » n'existe pas : la fiche est identique à celle de la 0.5.0.
- Une fiche avec « Autres champs » reste lue par la planification (critères, description) comme avant.
- Tests unitaires : repli actif et inactif, exclusion par défaut, exclusion configurée, champ déjà lu, champ non HTML.
