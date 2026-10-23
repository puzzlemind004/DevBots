---
source: "local"
source_id: "LOCAL-8"
parent: "LOCAL-F2"
created_at: "2026-10-23T14:00:00.000Z"
title: "Lister les stories d'une feature dans sa fiche, à jour à chaque import et synchro"
state: "open"
dependencies:
  - "LOCAL-7"
---

# Lister les stories d'une feature dans sa fiche, à jour à chaque import et synchro

## Description

La fiche de feature se termine par une section `## Stories` : la liste de ses
stories enfants, avec id, titre et lien vers leur carte chez la source.

```md
## Stories

- [48012](https://dev.azure.com/…/_workitems/edit/48012) — Afficher les CNILs
- [48013](…) — Sélectionner les consentements CNIL
- [48014](…) — Gérer les consentements obligatoires
```

La liste reflète la source, pas seulement ce qui a été importé : une story
enfant non importée y figure aussi. Elle se tient à jour **à chaque import et à
chaque synchro**.

Or aujourd'hui la resynchronisation (`resyncStories`, `src/core/resync.ts`) ne
relit que les stories de `new/` et `ready/` : les features de `features/` ne
sont jamais relues. Cette story l'étend aux features importées de la source
configurée. La fiche de feature est réécrite sur place quand sa révision
change, comme à l'import (`importFeatures`, `src/core/workDir.ts`).

Point d'attention : ajouter ou retirer un enfant change-t-il la révision
Azure de la feature ? Les relations en font partie, donc oui en principe : à
confirmer. Sinon, comparer aussi la liste des enfants pour décider d'une
réécriture.

Les titres des enfants viennent d'une lecture groupée des work items enfants
(`getWorkItems` par lots de 200, comme `fetchTickets`), ou des fiches locales
quand elles existent : à trancher à la planification, en évitant une lecture
par enfant.

## Critères d'acceptation

- La fiche de feature importée se termine par `## Stories`, une ligne par enfant : id lié à sa carte chez la source, puis titre.
- Une story enfant non importée figure dans la liste.
- Une feature sans enfant affiche une mention explicite plutôt qu'une section vide.
- Une synchro relit les features importées de la source configurée : une story ajoutée sous la feature dans Azure apparaît dans la liste, une story retirée disparaît.
- Une synchro sans changement ne réécrit pas la fiche de feature.
- Les features locales ne sont pas relues par la synchro.
- Côté GitHub, soit les sub-issues d'une issue parente devenue feature sont listées de la même façon, soit le comportement reste inchangé : le choix est écrit dans le plan.
- Tests unitaires : rendu de la liste, synchro avec ajout puis retrait d'un enfant.
